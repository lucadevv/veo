# Calibración de umbrales biométricos — runbook

> Objetivo: reemplazar los umbrales **heurísticos** de `app/config.py` por valores
> **calibrados con datos** (FMR / FNMR / DET / EER) sobre la población real de VEO **antes de prod**.
> Este documento es la metodología; `scripts/calibrate_threshold.py` es el harness que la ejecuta.

---

## 0. Qué número estamos calibrando (y qué NO es)

| Setting (`config.py`) | Default | Qué compara | Métrica | Pasa si |
|---|---|---|---|---|
| `doc_match_threshold` | **0.30** | selfie enrolada ↔ rostro del **DNI** (`/v1/face-match`, KYC binding) | **similitud coseno** | `score >= 0.30` |
| `match_threshold` | 0.40 | selfie del turno ↔ selfie enrolada (`/v1/verify`, gate de turno) | similitud coseno | `score >= 0.40` |
| `liveness_consistency_threshold` | 0.35 | frame ↔ frame **intra-sesión** (anti-splicing) | similitud coseno | `score >= 0.35` |
| `spoof_threshold` | 0.60 | prob. de clase "viva" del PAD MiniFASNet | prob. softmax | `p_live >= 0.60` |

**El `0.30` es una SIMILITUD coseno, NO una distancia.** Mayor = más parecido. El match
aprueba con `score >= umbral` (ver `app/domain.py:decide` y `app/api/routes.py:face_match`).
`score = max(0, cosine(probe, ref))` con embeddings ArcFace **L2-normalizados de 512-d**
(`app/face/matcher.py`), por lo que coseno ≡ producto punto y el rango operativo real es `[0, 1]`.

**Modelo:** pack InsightFace `buffalo_l` → recognizer **ArcFace `w600k_r50.onnx`** (ResNet-50
entrenado sobre WebFace600K/Glint360K), embedding 512-d, preproc `(x-127.5)/127.5` sobre crop
alineado 112×112, salida L2-normalizada. Rango natural de coseno: **misma persona** live↔live
≈ 0.4–0.7; **misma persona** doc↔selfie ≈ 0.3–0.45 (el DNI es foto vieja/baja-res/con holograma);
**impostores** ≈ 0.0–0.2. La franja "oficial" InsightFace para este pack cae en ~0.28–0.45 según
el FMR objetivo. Estos son valores de LITERATURA — hay que confirmarlos con datos propios.

**Este runbook calibra un umbral por vez.** El `doc_match_threshold` (KYC) es el prioritario porque
es la deuda marcada y el de mayor consecuencia de seguridad (ver §4). El mismo procedimiento sirve
para `match_threshold` (con pares live↔live) y `liveness_consistency_threshold`.

---

## 1. Definiciones (fijar el vocabulario antes de medir)

Para un umbral `τ`, sobre un conjunto de pares etiquetados:

- **Par GENUINE**: las dos imágenes son de la **misma** persona (p. ej. selfie enrolada + su DNI).
- **Par IMPOSTOR**: las dos imágenes son de personas **distintas** (selfie de A + DNI de B).
- **FMR(τ)** — *False Match Rate*: proporción de pares **impostor** con `score >= τ`.
  Un impostor ACEPTADO. **Este es el error de SEGURIDAD** (suplantación de conductor).
- **FNMR(τ)** — *False Non-Match Rate*: proporción de pares **genuine** con `score < τ`.
  Un legítimo RECHAZADO. **Este es el error de FRICCIÓN** (el conductor reintenta el gate).
- **Curva DET** (*Detection Error Tradeoff*): FMR vs FNMR al barrer `τ` (habitualmente en ejes
  de desviación normal / log). Cada punto es un `τ` posible.
- **EER** — *Equal Error Rate*: el `τ` donde `FMR(τ) == FNMR(τ)`. Un **resumen** de la separabilidad
  del modelo, **NO** un punto de operación válido para este caso (ver §4).

> Nota de notación: en la literatura ISO/NIST se usa a veces FAR/FRR (a nivel de *decisión de sistema*,
> incluyen fallos de adquisición/detección) vs FMR/FNMR (a nivel de *comparación*). Nuestro harness
> mide **FMR/FNMR de comparación** (asume que hubo detección de 1 rostro). Los fallos de detección
> —0 rostros / >1 rostro— se cuentan aparte como *Failure-To-Acquire* y NO se mezclan en la curva.

---

## 2. El dataset que hay que conseguir

El harness NO inventa datos. Necesita pares etiquetados de la **población real** (o el proxy más
cercano). Sin esto, cualquier número es indefendible.

### 2.1 Composición

Para el `doc_match_threshold` (KYC, el prioritario):

- **Pares GENUINE**: `selfie_live` + `foto_del_DNI` de la **misma** persona. Fuente ideal: los enrolamientos
  reales del piloto (con consentimiento Ley 29733 y minimización — ver §6).
- **Pares IMPOSTOR**: `selfie` de A + `DNI` de B, con A ≠ B. Se generan **combinatoriamente** a partir del
  mismo pool (N personas → hasta N·(N-1) pares impostor cruzados), por eso el pool de impostores crece
  rápido aunque haya pocas personas.

Para `match_threshold` (turno): pares GENUINE = dos selfies live de la misma persona en sesiones
distintas; IMPOSTOR = selfies de personas distintas.

### 2.2 Tamaño mínimo (significancia)

El cuello de botella es el **FMR objetivo bajo**: para *medir* un FMR de 0.1% necesitás ver del orden
de miles de pares impostor, y para *estimar con intervalo de confianza* alrededor de ese punto, más.
Regla de trabajo (regla del 3 / "rule of three" para el límite superior de un evento raro):

| FMR objetivo | Pares impostor MÍNIMOS para poder *observar* el punto | Cómodo (IC estrecho) |
|---|---|---|
| 1% (1e-2) | ~300 | ~1 000 |
| 0.1% (1e-3) | ~3 000 | ~10 000 |
| 0.01% (1e-4) | ~30 000 | ~100 000 |

- Regla práctica: para estimar un FMR objetivo `p`, apuntá a **≥ 10/p** pares impostor (10 falsos matches
  esperados en el punto) para que la estimación no sea 0/N. Con `10/p` el IC sigue siendo ancho; `100/p`
  ya da un IC razonable.
- **Pares GENUINE**: bastan muchos menos para el FNMR (el FNMR objetivo no es tan extremo). Apuntá a
  **≥ 300–500 personas** con su par genuine para un FNMR estimado con ±2–3%. Menos de ~100 personas
  hace que el FNMR quede muy ruidoso.
- Los pares impostor son **baratos** (combinatoria del mismo pool); las personas GENUINE son el recurso
  **caro** (cada una requiere enrolamiento real). Optimizá por número de PERSONAS distintas.

> **Conclusión operativa:** un FMR objetivo de **0.01%** exige un pool grande (decenas de miles de pares
> impostor → cientos de personas). Si el piloto arranca con ~200–500 personas, se puede calibrar con
> honestidad hasta **FMR ≈ 0.1%**, reportando el 0.01% como *extrapolación con IC ancho* hasta juntar más.

### 2.3 Estratificación por sesgo demográfico (NO opcional)

Los modelos de reconocimiento facial tienen **FMR desigual entre subgrupos**: la literatura (NIST FRVT
Part 3: Demographic Effects) muestra FMR **más alto** —o sea, más suplantaciones aceptadas— en pieles
más oscuras, en mujeres, y en los extremos de edad. Un umbral global "promedio" puede esconder un
subgrupo con FMR 5–10× peor. Para Lima/Perú:

- **Estratificar** el dataset y **reportar FMR/FNMR por subgrupo**, no solo global: tono de piel
  (p. ej. escala Monk/Fitzpatrick agrupada), género, y rango etario. Población andina/mestiza/afroperuana
  representada de forma proporcional a la base de conductores esperada.
- **Regla de decisión conservadora:** el umbral se fija para que el FMR del **PEOR subgrupo** cumpla el
  objetivo, no el promedio. (Si eso castiga demasiado el FNMR de otro subgrupo, es señal de que el
  MODELO no sirve para producción y hay que cambiarlo/re-entrenar — el umbral no arregla un modelo sesgado.)
- Documentar el balance del dataset en el reporte de calibración; un dataset no estratificado produce un
  umbral que *parece* seguro y no lo es para el subgrupo peor representado.

---

## 3. Cómo se computa (lo que hace el harness)

1. **Scores**: para cada par se computa el score con el **MISMO pipeline del servicio**
   (`app.face.embedder.ArcFaceEmbedder` → `app.face.matcher.cosine_similarity` / `match_score`).
   El harness NO reimplementa la métrica: importa las funciones reales. Salida: dos vectores de scores,
   `genuine[]` e `impostor[]`.
2. **Barrido**: se recorre `τ` sobre una grilla fina en `[0, 1]` (paso configurable, p. ej. 0.005).
3. **Para cada τ**: `FMR(τ) = #{impostor >= τ} / N_impostor`, `FNMR(τ) = #{genuine < τ} / N_genuine`.
4. **EER**: el `τ` que minimiza `|FMR − FNMR|` (con interpolación).
5. **Operating points por FMR objetivo**: para cada objetivo `p ∈ {1%, 0.1%, 0.01%}`, el **menor `τ`**
   tal que `FMR(τ) <= p`, y se **lee el FNMR resultante** en ese `τ`. Ese FNMR es el "costo de fricción"
   que se paga por esa seguridad.
6. **Salida**: tabla FMR/FNMR por umbral, EER, y la tabla de operating points recomendados + el
   número de pares (para saber si el punto es estadísticamente sostenible).

---

## 4. Cómo elegir el operating point — por FMR objetivo, NO por EER

**El EER NO es el criterio correcto para VEO.** El EER asume que el costo de un false match (impostor
aceptado) y el de un false non-match (legítimo rechazado) son **iguales**. En VEO **no lo son**:

- **False MATCH (FMR)** = un impostor se hace pasar por el conductor legítimo → **suplantación de
  identidad del conductor**. Esto rompe el diferenciador NO NEGOCIABLE de VEO (movilidad *segura* en
  Lima). Un pasajero sube a un auto conducido por alguien que NO es quien VEO verificó. Costo: **gravísimo**
  (seguridad física, legal, reputacional, y compliance Ley 29733 del binding de identidad).
- **False NON-MATCH (FNMR)** = un conductor legítimo es rechazado en el gate → **fricción**: reintenta la
  captura, mejor luz, otro frame. Costo: **operativo, recuperable, acotado.**

Por lo tanto: **costo(FMR) ≫ costo(FNMR)**. Se **fija un FMR objetivo bajo** y se **acepta el FNMR que
resulte**. El EER se reporta solo como referencia de separabilidad del modelo (y para detectar si el
modelo es tan malo que ni siquiera el EER es tolerable).

### 4.1 Qué FMR objetivo es defendible para VEO (framework, no número final)

- El `doc_match` es un gate de **KYC de alto valor** (binding conductor↔documento), que se ejecuta **pocas
  veces por persona** (en el registro), NO en cada turno. Eso permite ser **estricto** en FMR sin castigar
  la operación diaria: un FNMR más alto acá solo significa que algunos registros piden re-captura del DNI.
- Referencia regulatoria: guías tipo **FIDO/NIST** para verificación biométrica de identidad de alto valor
  suelen pedir **FMR ≤ 0.01% (1e-4)** con FNMR razonable (p. ej. ≤ 3–5%). Para binding KYC de un producto
  cuyo diferenciador es la seguridad, apuntar a **FMR ≤ 0.1% (1e-3) como piso, 0.01% (1e-4) como meta**
  es defendible.
- El **gate de turno** (`match_threshold`, live↔live, se corre MUCHAS veces al día) tolera un FMR igual de
  estricto pero hay que vigilar el FNMR: si es muy alto genera fricción diaria. Ahí sí el trade-off pesa
  más el FNMR — pero **nunca** al punto de subir el FMR por comodidad.

### 4.2 Qué significaría esto para el 0.30 actual

- Como `w600k_r50` da **misma persona doc↔selfie ≈ 0.30–0.45** e **impostores ≈ 0.0–0.2**, un umbral de
  **0.30 cae en el borde INFERIOR** de la franja genuine. Es un valor elegido para **minimizar FNMR**
  (no rechazar registros legítimos con DNI viejo), lo cual es **razonable como default de arranque** pero
  **sospechoso de ser laxo en FMR** para el objetivo de seguridad: cuanto más bajás el umbral, más impostores
  con parecido facial (familiares, dobles) pueden colarse por encima de 0.30.
- **Hipótesis a confirmar con datos:** es plausible que el FMR a 0.30 en la población real esté en el orden
  de **~0.1–1%**, es decir **por encima** de un objetivo KYC de 0.01%. Si la calibración lo confirma, el
  `doc_match_threshold` debería **subir** (p. ej. a ~0.35–0.40) aceptando algo más de FNMR — o, si eso
  dispara demasiado el FNMR del DNI viejo, la conclusión es que doc↔selfie necesita **otra palanca** (mejor
  captura del DNI, o un modelo específico para doc-matching), no solo mover el umbral.
- **Esto es una HIPÓTESIS, no un veredicto.** El número sale de correr el harness sobre el dataset real.

---

## 5. Procedimiento paso a paso

```bash
cd services/biometric-service
source .venv/bin/activate            # venv del servicio (numpy + onnxruntime ya instalados)

# --- Opción A: ya tenés scores precomputados (label,score) ---
python scripts/calibrate_threshold.py --scores-csv data/doc_scores.csv

# --- Opción B: tenés pares de imágenes etiquetados y querés que el SERVICIO compute los scores ---
#     CSV con columnas: label,image_a,image_b   (label ∈ genuine|impostor)
python scripts/calibrate_threshold.py --pairs-csv data/doc_pairs.csv --model-dir models

# --- Demo sin dataset (distribución sintética, para ver el formato de salida) ---
python scripts/calibrate_threshold.py --demo

# Opcionales:
#   --fmr-targets 0.01,0.001,0.0001   (objetivos FMR; default 1%,0.1%,0.01%)
#   --step 0.005                      (paso del barrido de τ)
#   --by-group data/groups.csv        (estratificar: label,score,group → tabla por subgrupo)
```

Salida: tabla FMR/FNMR por τ, EER, y tabla de operating points por FMR objetivo con el FNMR resultante y
el `τ` recomendado. Cuando se pasa `--by-group`, además una tabla por subgrupo demográfico (§2.3).

### Aplicar el resultado

El umbral es 100% configurable por env — **no se toca código**:

```bash
VEO_BIO_DOC_MATCH_THRESHOLD=0.37   # ejemplo; el valor sale del harness
```

Guardar el reporte del harness + el dataset (metadata, NO las imágenes crudas) como **evidencia de
compliance** del punto de operación elegido, con fecha y versión del modelo.

---

## 6. Compliance del dataset (Ley 29733)

- Los pares de calibración son **datos biométricos sensibles**: consentimiento explícito, finalidad
  declarada (calibración de seguridad), y **minimización**. Preferir **embeddings/scores** sobre imágenes
  crudas siempre que se pueda; si se guardan imágenes, cifradas en reposo (AES-256) en MinIO self-hosted
  con object-lock y retención mínima.
- El pipeline de scoring corre **self-hosted** (ArcFace ONNX propio) — el dataset NUNCA sale a un tercero,
  coherente con la soberanía del dato (FOUNDATION §0.7).
- El reporte de calibración se audita: umbral elegido, FMR/FNMR por subgrupo, tamaño del dataset, fecha,
  hash del modelo ONNX. Sin esto el punto de operación no es defendible ante una auditoría.

---

## 7. Checklist de cierre (Definition of Done de la deuda)

- [ ] Dataset con ≥ 300–500 personas GENUINE reales (o proxy justificado) + pool impostor combinatorio.
- [ ] Estratificado por tono de piel / género / edad, con composición documentada.
- [ ] `calibrate_threshold.py` corrido sobre el dataset → tabla FMR/FNMR + EER + operating points.
- [ ] Operating point elegido por **FMR objetivo** (no EER), con el FMR del **peor subgrupo** cumpliendo el objetivo.
- [ ] `VEO_BIO_DOC_MATCH_THRESHOLD` (y, si se calibró, `VEO_BIO_MATCH_THRESHOLD`) seteado en el env de prod.
- [ ] Reporte + metadata guardados como evidencia de compliance (fecha, modelo, tamaño, FNMR resultante).
- [ ] Deuda `config.py:80` actualizada/eliminada con el valor calibrado y link al reporte.
