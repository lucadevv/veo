# =============================================================
# tracking-service · build multi-stage
# H3 (uber/h3-go) usa cgo → requiere toolchain C en la etapa de build.
# Runtime: alpine (musl) compatible con el binario compilado en alpine.
# =============================================================
FROM golang:1.26-alpine AS builder

RUN apk add --no-cache gcc musl-dev

WORKDIR /src

COPY go.mod go.sum ./
RUN go mod download

COPY . .

ENV CGO_ENABLED=1 GOOS=linux
RUN go build -trimpath -ldflags="-s -w" -o /out/tracking-service ./cmd/server

# --- Runtime ---
FROM alpine:3.20 AS runner

RUN apk add --no-cache ca-certificates wget && \
    addgroup -S veo && adduser -S veo -G veo

WORKDIR /app
COPY --from=builder /out/tracking-service /app/tracking-service

ENV TRACKING_HTTP_ADDR=:3004
EXPOSE 3004

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
    CMD wget -qO- http://localhost:3004/health || exit 1

USER veo
ENTRYPOINT ["/app/tracking-service"]
