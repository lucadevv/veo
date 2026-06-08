# Mapbox iOS — token de descarga (`sk.`)

> Lote 4: migración del mapa del pasajero a `@rnmapbox/maps` (Mapbox Maps SDK iOS ~> 10.16),
> gemelo del conductor.

## El problema

El SDK nativo de Mapbox para iOS se descarga del repositorio de Mapbox **bajo autenticación**.
`pod install` necesita un **secret access token** con scope `DOWNLOADS:READ` (empieza con `sk.`).
Este token NO es el token público de runtime (`pk.`) y **no va al repo ni al binario**: es una
credencial de **máquina/CI**.

> Nota: en **Android NO** hace falta este token (Mapbox levantó el requisito de auth en el repo de
> releases Maven). Este blocker es **solo de iOS**.

## Dónde va el `sk.` (aún no disponible)

Se configura en `~/.netrc` de la máquina del desarrollador (o como secret en CI):

```
machine api.mapbox.com
  login mapbox
  password sk.<DOWNLOADS_READ_TOKEN_AQUI>
```

Pasos:

1. En el dashboard de Mapbox de la cuenta `puntossmartperu`, crear un token con el scope
   **`DOWNLOADS:READ`** (token secreto, `sk.`).
2. Crear/editar `~/.netrc` con el bloque de arriba y restringir permisos: `chmod 600 ~/.netrc`.
3. Recién entonces:
   ```sh
   cd ios && pod install
   ```

Sin ese `~/.netrc`, `pod install` falla al resolver `MapboxMaps`.

## Token público de runtime (`pk.`) — distinto

El `pk.` que el SDK usa en runtime para bajar teselas/glyphs vive en `env/dev.secret.env`
(gitignored) como `MAPBOX_ACCESS_TOKEN`, y lo registra `Mapbox.setAccessToken` en el bootstrap
nativo (`src/core/maps/mapbox.ts`, invocado desde `src/bootstrap/native.ts`).

## Versión

El pin del SDK nativo está en `ios/Podfile` (`$RNMapboxMapsVersion = '~> 10.16.0'`) y en
`android/build.gradle` (`RNMapboxMapsVersion = '10.16.6'`). Mantenerlos alineados al actualizar
`@rnmapbox/maps`.
