// Local dev (npm run floorplan) has a real server with GET/POST /api/apartments.
// Anywhere else (e.g. GitHub Pages) is static-only -- saves go straight to
// Supabase instead, using a public row keyed by APARTMENTS_SUPABASE_ROW_ID.
// Same pattern as src/floorplan/floorplan.js, just a different table.
//
// Internals are prefixed APARTMENTS_* / apartmentsSupabaseClient (rather than
// the shorter names floorplan.js uses) because this file is also loaded on
// the floor plan page, which declares its own IS_LOCAL/SUPABASE_* for the
// floorplan_state table -- unprefixed names here would collide with those.
const APARTMENTS_IS_LOCAL = location.hostname === "localhost" || location.hostname === "127.0.0.1";

const APARTMENTS_SUPABASE_URL = "https://gkfgypoqicqbjfmcnpxk.supabase.co";
const APARTMENTS_SUPABASE_KEY = "sb_publishable_PJG8viNrEpnPCr1TMpuhNA_6L6Kx4Nq";
const APARTMENTS_SUPABASE_TABLE = "apartments_state";
const APARTMENTS_SUPABASE_ROW_ID = 1;
const apartmentsSupabaseClient = APARTMENTS_IS_LOCAL
  ? null
  : window.supabase.createClient(APARTMENTS_SUPABASE_URL, APARTMENTS_SUPABASE_KEY);

function loadApartments() {
  if (APARTMENTS_IS_LOCAL) {
    return fetch("/api/apartments").then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    });
  }
  return apartmentsSupabaseClient
    .from(APARTMENTS_SUPABASE_TABLE)
    .select("data")
    .eq("id", APARTMENTS_SUPABASE_ROW_ID)
    .single()
    .then(({ data, error }) => {
      if (error) throw error;
      return data.data;
    });
}

function saveApartments(apartments) {
  const payload = { apartments };

  if (APARTMENTS_IS_LOCAL) {
    return fetch("/api/apartments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    });
  }

  return apartmentsSupabaseClient
    .from(APARTMENTS_SUPABASE_TABLE)
    .upsert({ id: APARTMENTS_SUPABASE_ROW_ID, data: payload, updated_at: new Date().toISOString() })
    .then(({ error }) => {
      if (error) throw error;
      return payload;
    });
}
