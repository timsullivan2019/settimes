-- Venues whose name geocodes to an unrelated POI inside the NYC bounding box
-- ("Paradise Coney Island" → a flower shop). backfill-venues.ts retries every
-- null-geog venue on each run, so a hand-nulled wrong point silently comes
-- back — geocode_blocked makes the null stick. notes records why.
alter table venues add column if not exists geocode_blocked boolean not null default false;
alter table venues add column if not exists notes text;
