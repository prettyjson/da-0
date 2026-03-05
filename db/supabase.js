const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
    console.warn('[WARN] Supabase credentials not set - falling back to SQLite');
}

const supabase = supabaseUrl && supabaseServiceKey
    ? createClient(supabaseUrl, supabaseServiceKey)
    : null;

function getSupabase() {
    return supabase;
}

function isSupabaseEnabled() {
    return supabase !== null;
}

module.exports = { getSupabase, isSupabaseEnabled };
