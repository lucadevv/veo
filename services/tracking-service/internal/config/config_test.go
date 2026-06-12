package config

import (
	"strings"
	"testing"
	"time"
)

// baseProdConfig devuelve un Config válido salvo por los secretos, para aislar
// el comportamiento de validateSecrets sin depender de las env vars del proceso.
func baseProdConfig() Config {
	return Config{
		Env:                "production",
		KafkaBrokers:       []string{"broker:9094"},
		H3Resolution:       9,
		PresenceTTL:        60 * time.Second,
		ClickHousePassword: "una-credencial-fuerte",
	}
}

func TestValidateSecrets_ClickHouse(t *testing.T) {
	tests := []struct {
		name     string
		env      string
		password string
		wantErr  bool
	}{
		{"prod password vacío falla", "production", "", true},
		{"prod password dev falla", "production", devClickHousePassword, true},
		{"prod password fuerte ok", "production", "s3cr3t-fuerte", false},
		{"development con default ok", "development", devClickHousePassword, false},
		{"development password vacío ok", "development", "", false},
		{"test con default ok", "test", devClickHousePassword, false},
		{"Production mayúscula también falla", "Production", "", true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cfg := baseProdConfig()
			cfg.Env = tt.env
			cfg.ClickHousePassword = tt.password

			err := cfg.validate()

			if (err != nil) != tt.wantErr {
				t.Fatalf("validate() error = %v, wantErr %v", err, tt.wantErr)
			}
			if tt.wantErr && err != nil && !strings.Contains(err.Error(), "CLICKHOUSE_PASSWORD") {
				t.Errorf("error debería mencionar CLICKHOUSE_PASSWORD, got %q", err.Error())
			}
		})
	}
}

func TestValidateSecrets_MQTT(t *testing.T) {
	tests := []struct {
		name     string
		env      string
		username string
		password string
		wantErr  bool
	}{
		{"prod user sin password falla", "production", "tracking", "", true},
		{"prod user con password ok", "production", "tracking", "p4ss", false},
		{"prod sin user sin password ok (mTLS/sin-auth)", "production", "", "", false},
		{"development user sin password ok", "development", "tracking", "", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cfg := baseProdConfig()
			cfg.Env = tt.env
			cfg.MQTTUsername = tt.username
			cfg.MQTTPassword = tt.password

			err := cfg.validate()

			if (err != nil) != tt.wantErr {
				t.Fatalf("validate() error = %v, wantErr %v", err, tt.wantErr)
			}
			if tt.wantErr && err != nil && !strings.Contains(err.Error(), "MQTT_PASSWORD") {
				t.Errorf("error debería mencionar MQTT_PASSWORD, got %q", err.Error())
			}
		})
	}
}

func TestIsProduction(t *testing.T) {
	tests := []struct {
		env  string
		want bool
	}{
		{"production", true},
		{"Production", true},
		{"PRODUCTION", true},
		{"development", false},
		{"test", false},
		{"", false},
		{"prod", false},
	}

	for _, tt := range tests {
		t.Run(tt.env, func(t *testing.T) {
			cfg := Config{Env: tt.env}
			if got := cfg.isProduction(); got != tt.want {
				t.Errorf("isProduction(%q) = %v, want %v", tt.env, got, tt.want)
			}
		})
	}
}

func TestLoad_DevelopmentDefaultsOK(t *testing.T) {
	// Sin env vars de producción, Load() debe arrancar con los defaults del
	// dev-stack (incluida la credencial dev de ClickHouse) sin error.
	t.Setenv("APP_ENV", "")
	t.Setenv("NODE_ENV", "")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() en development no debería fallar: %v", err)
	}
	if cfg.Env != "development" {
		t.Errorf("Env = %q, want development", cfg.Env)
	}
	if cfg.ClickHousePassword != devClickHousePassword {
		t.Errorf("ClickHousePassword = %q, want default dev %q", cfg.ClickHousePassword, devClickHousePassword)
	}
}

func TestLoad_ProductionFailsWithDevClickHousePassword(t *testing.T) {
	// En producción, sin CLICKHOUSE_PASSWORD propio, el default dev debe abortar.
	t.Setenv("NODE_ENV", "production")
	t.Setenv("APP_ENV", "")
	t.Setenv("CLICKHOUSE_PASSWORD", "") // fuerza el default "veo_dev"

	_, err := Load()
	if err == nil {
		t.Fatal("Load() en producción con CLICKHOUSE_PASSWORD=veo_dev debería fallar")
	}
	if !strings.Contains(err.Error(), "CLICKHOUSE_PASSWORD") {
		t.Errorf("error debería mencionar CLICKHOUSE_PASSWORD, got %q", err.Error())
	}
}

func TestLoad_ProductionOKWithStrongSecrets(t *testing.T) {
	t.Setenv("NODE_ENV", "production")
	t.Setenv("APP_ENV", "")
	t.Setenv("CLICKHOUSE_PASSWORD", "credencial-fuerte-de-prod")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() en producción con secretos fuertes no debería fallar: %v", err)
	}
	if !cfg.isProduction() {
		t.Errorf("isProduction() = false, want true (Env=%q)", cfg.Env)
	}
}
