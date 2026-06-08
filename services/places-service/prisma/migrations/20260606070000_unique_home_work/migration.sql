-- Unicidad de HOME/WORK por usuario (defensa en profundidad: la lógica de PlacesService ya hace upsert,
-- pero este índice único PARCIAL garantiza el invariante a nivel de DB —imposible duplicar Casa/Trabajo
-- por una condición de carrera—. Los FAVORITE quedan fuera del índice (admiten varios por usuario).
CREATE UNIQUE INDEX "saved_places_user_id_kind_unique"
  ON "places"."saved_places" ("user_id", "kind")
  WHERE "kind" IN ('HOME', 'WORK');
