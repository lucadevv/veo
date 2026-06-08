// Package history persiste cada ping GPS en ClickHouse (tabla gps_pings, TTL 90 días).
// La inserción es asíncrona y por lotes para sostener 1 Hz por conductor a escala.
package history

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2"
	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
)

// DDL de la tabla de histórico GPS. Idempotente (IF NOT EXISTS).
const createTableDDL = `
CREATE TABLE IF NOT EXISTS gps_pings (
	driver_id          String,
	trip_id            Nullable(String),
	lat                Float64,
	lon                Float64,
	speed              Float32,
	heading            Float32,
	accuracy           Float32,
	recorded_at        DateTime64(3, 'UTC'),
	server_received_at DateTime64(3, 'UTC')
)
ENGINE = MergeTree
PARTITION BY toYYYYMMDD(recorded_at)
ORDER BY (driver_id, recorded_at)
TTL toDateTime(recorded_at) + INTERVAL 90 DAY
SETTINGS index_granularity = 8192
`

// Record es una fila de gps_pings.
type Record struct {
	DriverID         string
	TripID           string // vacío → NULL
	Lat              float64
	Lon              float64
	Speed            float64
	Heading          float64
	Accuracy         float64
	RecordedAt       time.Time
	ServerReceivedAt time.Time
}

// Store abstrae la persistencia histórica (DIP).
type Store interface {
	Insert(r Record) error
	// Delete borra todo el histórico GPS de un conductor (derecho al olvido, Ley 29733).
	// Idempotente: borrar un conductor inexistente es un no-op.
	Delete(ctx context.Context, driverID string) error
	Ping(ctx context.Context) error
	Close() error
}

// Options configura el batcher de ClickHouse.
type Options struct {
	Addr       string
	Database   string
	Username   string
	Password   string
	BatchSize  int
	FlushEvery time.Duration
	BufferSize int
	Logger     *slog.Logger
}

// ClickHouse implementa Store con escritura por lotes.
type ClickHouse struct {
	conn      driver.Conn
	buf       chan Record
	batchSize int
	flushEch  time.Duration
	log       *slog.Logger

	wg       sync.WaitGroup
	closed   chan struct{}
	closeOne sync.Once
}

// Open conecta a ClickHouse, crea la tabla si no existe y arranca el flusher.
func Open(ctx context.Context, opts Options) (*ClickHouse, error) {
	if opts.BatchSize <= 0 {
		opts.BatchSize = 500
	}
	if opts.FlushEvery <= 0 {
		opts.FlushEvery = time.Second
	}
	if opts.BufferSize <= 0 {
		opts.BufferSize = 10_000
	}
	if opts.Logger == nil {
		opts.Logger = slog.Default()
	}

	conn, err := clickhouse.Open(&clickhouse.Options{
		Addr: []string{opts.Addr},
		Auth: clickhouse.Auth{
			Database: opts.Database,
			Username: opts.Username,
			Password: opts.Password,
		},
		DialTimeout: 5 * time.Second,
		Compression: &clickhouse.Compression{Method: clickhouse.CompressionLZ4},
	})
	if err != nil {
		return nil, fmt.Errorf("history: abrir clickhouse: %w", err)
	}
	if err := conn.Ping(ctx); err != nil {
		return nil, fmt.Errorf("history: ping clickhouse: %w", err)
	}
	if err := conn.Exec(ctx, createTableDDL); err != nil {
		return nil, fmt.Errorf("history: crear tabla gps_pings: %w", err)
	}

	ch := &ClickHouse{
		conn:      conn,
		buf:       make(chan Record, opts.BufferSize),
		batchSize: opts.BatchSize,
		flushEch:  opts.FlushEvery,
		log:       opts.Logger,
		closed:    make(chan struct{}),
	}
	ch.wg.Add(1)
	go ch.run()
	return ch, nil
}

// Insert encola un registro para escritura asíncrona. No bloquea; descarta si el buffer está lleno.
func (c *ClickHouse) Insert(r Record) error {
	select {
	case c.buf <- r:
		return nil
	default:
		return fmt.Errorf("history: buffer lleno, ping descartado driver=%s", r.DriverID)
	}
}

// Delete elimina todo el histórico GPS de un conductor con un borrado ligero de
// ClickHouse (DELETE FROM ... WHERE). Idempotente: si no hay filas, es un no-op.
// driverID vacío se ignora para no disparar un borrado masivo accidental.
func (c *ClickHouse) Delete(ctx context.Context, driverID string) error {
	if driverID == "" {
		return nil
	}
	if err := c.conn.Exec(ctx, "DELETE FROM gps_pings WHERE driver_id = ?", driverID); err != nil {
		return fmt.Errorf("history: borrar histórico driver=%s: %w", driverID, err)
	}
	return nil
}

// Ping verifica conectividad (readiness).
func (c *ClickHouse) Ping(ctx context.Context) error {
	if err := c.conn.Ping(ctx); err != nil {
		return fmt.Errorf("history: ping: %w", err)
	}
	return nil
}

func (c *ClickHouse) run() {
	defer c.wg.Done()
	ticker := time.NewTicker(c.flushEch)
	defer ticker.Stop()

	batch := make([]Record, 0, c.batchSize)
	flush := func() {
		if len(batch) == 0 {
			return
		}
		if err := c.send(batch); err != nil {
			c.log.Error("history: fallo al insertar lote", slog.Int("rows", len(batch)), slog.Any("err", err))
		}
		batch = batch[:0]
	}

	for {
		select {
		case <-c.closed:
			// Drenar lo que quede en el buffer antes de salir.
			for {
				select {
				case r := <-c.buf:
					batch = append(batch, r)
					if len(batch) >= c.batchSize {
						flush()
					}
				default:
					flush()
					return
				}
			}
		case r := <-c.buf:
			batch = append(batch, r)
			if len(batch) >= c.batchSize {
				flush()
			}
		case <-ticker.C:
			flush()
		}
	}
}

func (c *ClickHouse) send(rows []Record) error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	batch, err := c.conn.PrepareBatch(ctx, "INSERT INTO gps_pings")
	if err != nil {
		return fmt.Errorf("history: preparar lote: %w", err)
	}
	for _, r := range rows {
		var tripID *string
		if r.TripID != "" {
			tid := r.TripID
			tripID = &tid
		}
		if err := batch.Append(
			r.DriverID,
			tripID,
			r.Lat,
			r.Lon,
			float32(r.Speed),
			float32(r.Heading),
			float32(r.Accuracy),
			r.RecordedAt,
			r.ServerReceivedAt,
		); err != nil {
			return fmt.Errorf("history: append fila: %w", err)
		}
	}
	if err := batch.Send(); err != nil {
		return fmt.Errorf("history: enviar lote: %w", err)
	}
	return nil
}

// Close detiene el flusher, drena el buffer y cierra la conexión.
func (c *ClickHouse) Close() error {
	c.closeOne.Do(func() { close(c.closed) })
	c.wg.Wait()
	if err := c.conn.Close(); err != nil {
		return fmt.Errorf("history: cerrar conexión: %w", err)
	}
	return nil
}
