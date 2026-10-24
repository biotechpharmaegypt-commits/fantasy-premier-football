// Sync Premier League data into Supabase.
// Usage:
//   npm i @supabase/supabase-js
//   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node sync-fpl.mjs
//   (add "live" to also pull per-player stats of the current/last gameweek)
//
// Run it on a schedule (GitHub Actions cron / Supabase scheduled function).
// NOTE: the official FPL API is unofficial/unlicensed; fine for personal use.

import { createClient } from "@supabase/supabase-js";

const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY");
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const BASE = "https://fantasy.premierleague.com/api";

async function get(path) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "User-Agent": "Mozilla/5.0 fantasy-app-sync" },
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

async function upsert(table, rows, onConflict) {
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await sb
      .from(table)
      .upsert(rows.slice(i, i + 500), { onConflict });
    if (error) throw new Error(`${table}: ${error.message}`);
  }
  console.log(`✔ ${table}: ${rows.length}`);
}

async function syncStatic() {
  const d = await get("/bootstrap-static/");

  await upsert(
    "teams",
    d.teams.map((t) => ({
      id: t.id,
      name: t.name,
      short_name: t.short_name,
      strength: t.strength,
      code: t.code,
    })),
    "id"
  );

  await upsert(
    "players",
    d.elements.map((p) => ({
      id: p.id,
      team_id: p.team,
      first_name: p.first_name,
      second_name: p.second_name,
      web_name: p.web_name,
      position: p.element_type,
      price: p.now_cost / 10,
      total_points: p.total_points,
      status: p.status,
      news: p.news || null,
      updated_at: new Date().toISOString(),
    })),
    "id"
  );

  await upsert(
    "gameweeks",
    d.events.map((e) => ({
      id: e.id,
      name: e.name,
      deadline_time: e.deadline_time,
      finished: e.finished,
      is_current: e.is_current,
      is_next: e.is_next,
    })),
    "id"
  );

  return d;
}

async function syncFixtures() {
  const fx = await get("/fixtures/");
  await upsert(
    "fixtures",
    fx
      .filter((f) => f.event) // skip unscheduled
      .map((f) => ({
        id: f.id,
        gameweek_id: f.event,
        home_team_id: f.team_h,
        away_team_id: f.team_a,
        kickoff_time: f.kickoff_time,
        home_score: f.team_h_score,
        away_score: f.team_a_score,
        finished: f.finished,
      })),
    "id"
  );
}

async function syncLive(gw) {
  const live = await get(`/event/${gw}/live/`);
  await upsert(
    "player_stats",
    live.elements.map((e) => ({
      player_id: e.id,
      gameweek_id: gw,
      minutes: e.stats.minutes,
      goals: e.stats.goals_scored,
      assists: e.stats.assists,
      clean_sheet: e.stats.clean_sheets > 0,
      goals_conceded: e.stats.goals_conceded,
      saves: e.stats.saves,
      yellow_cards: e.stats.yellow_cards,
      red_cards: e.stats.red_cards,
      own_goals: e.stats.own_goals,
      penalties_missed: e.stats.penalties_missed,
      penalties_saved: e.stats.penalties_saved,
      bonus: e.stats.bonus,
      points: e.stats.total_points,
    })),
    "player_id,gameweek_id"
  );
}

const d = await syncStatic();
await syncFixtures();

if (process.argv.includes("live")) {
  const cur = d.events.find((e) => e.is_current) ?? d.events.find((e) => e.is_next);
  if (cur) await syncLive(cur.id);
}
console.log("Done.");
