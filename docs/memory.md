# Alfred Memory Architecture

Alfred stores memory as one graph of immutable fact nodes. Messages are raw source material; the long-term memory unit is an extracted fact.

## Fact Levels

Every fact has `abstraction_level`:

| Level | Meaning | Examples | Expiry |
|---|---|---|---|
| `0` | Specific event, state, plan, or one-off observation | `User is tired`, `User has an exam on 2026-04-29`, `User played soccer yesterday` | Can expire |
| `1` | Behavioral pattern, habit, recurring context | `User plays soccer regularly`, `User struggles with consistent gym attendance` | Evolves by update/extension |
| `2` | Identity, value, durable self-model | `User values ambitious building projects`, `User fears wasting potential` | Evolves by update/extension |

`is_static` is independent from level. A past event can be static, and an identity/value fact can still change.

## Edge Semantics

`fact_relations.fact_id_a` is the source and `fact_id_b` is the target for every directed relation.

| Relation | Direction | Meaning |
|---|---|---|
| `instance_of` | child -> parent | Vertical abstraction. Only `L0 -> L1` and `L1 -> L2` are valid. |
| `updates` | new -> old | The old fact is contradicted or replaced. Old children stay attached as historical evidence. |
| `extends` | new -> old | The old fact was true but less specific. Children are rewired to the refined fact. |
| `derives` | inferred -> source | Inference from source facts. Sources remain active. |
| `consolidated_from` | summary -> source | A higher-level memory compressed lower-level evidence. |
| `relates_to` | undirected | Same-level semantic association. Stored in canonical min/max order. |

Facts are not edited in place. Corrections, refinements, and consolidations create new fact nodes and connect them to older nodes.

## Insertion Flow

1. The extractor emits atomic facts with:
   - `abstraction_level`
   - `is_static`
   - optional `event_date`
   - optional `forget_after` for level 0 only
   - optional `contradicts_hint`
   - optional `extends_hint`
   - optional `parent_hint`

2. Alfred inserts the new fact into SQLite.

3. If `contradicts_hint` resolves to an old fact:
   - insert `new --updates--> old`
   - set old `is_latest = 0`
   - keep old children attached to old
   - let the new fact inherit old parents

4. If `extends_hint` resolves to an old fact:
   - insert `new --extends--> old`
   - set old `is_latest = 0`
   - rewire old children to new
   - let the new fact inherit old parents

5. Alfred embeds the fact in ChromaDB with `abstraction_level` metadata.

6. Parent wiring:
   - level 0 searches for up to a small bounded set of level 1 parents
   - level 1 searches for up to a small bounded set of level 2 parents
   - level 2 has no parent
   - when a new level 1/2 fact is inserted, Alfred also searches downward for existing lower-level children that were extracted before the parent existed
   - `instance_of` edges update `descendant_count` on parents and ancestors

7. Lateral wiring:
   - same-level Chroma hits with distance `0.12..0.55` get `relates_to`

## Expiry And Consolidation

Only level 0 facts use `forget_after`.

Rules:

- current state without `event_date`: expires after about 12 hours
- dated event/plan: expires about 24 hours after `event_date`
- level 1 and level 2 facts do not expire by time

A consolidation cron runs every 6 hours:

1. Select expired level 0 facts where `is_latest = 1`.
2. Cluster them by semantic similarity.
3. Singletons are marked forgotten.
4. Durable clusters are summarized into a level 1 pattern.
5. The level 1 fact gets `consolidated_from` edges to sources.
6. Sources get `instance_of` edges to the new level 1 and are marked no longer latest.

A weekly promotion job clusters supported level 1 patterns into level 2 identity/value facts when warranted.

Superseded facts are version history, not expiry candidates. Consolidation only touches facts that are still latest and naturally aged out.

## Retrieval Layers

Prompt memory is assembled in layers:

1. **Core identity**: latest level 2 facts, always injected once.
2. **Foundational patterns**: level 1 facts ranked by `descendant_count`, always injected.
3. **Relevant memory**: query-specific Chroma + FTS results merged with RRF.
4. **Upward expansion**: retrieved level 0/1 facts pull in `instance_of` ancestors for context.
5. **Lateral expansion**: limited `relates_to` neighbors after upward expansion.

Level 2 facts are excluded from bedrock so they are not injected twice. Bedrock is explicitly level 1.

## Important Invariants

- `instance_of` is directed and adjacent-level only.
- A fact can have multiple `instance_of` parents, but they must all be exactly one level up.
- `relates_to` is undirected and same-level.
- `updates` does not rewire children.
- `extends` rewires children.
- `forget_after` applies only to level 0.
- Facts are immutable; history is represented by edges.

## Resetting Memory

For a clean restart of learned memory while preserving raw `messages`, run:

```bash
pnpm memory:reset -- --yes
```

For a true memory wipe, including the raw `messages` table that seeds the
startup short-term conversation buffer, run:

```bash
pnpm memory:reset -- --yes --include-messages
```

This clears `memory_facts`, `fact_relations`, `user_profile`, `reminders`, `proactive_log`, and the ChromaDB `alfred_facts` collection.

## Visualizing Memory

Generate a self-contained HTML graph:

```bash
pnpm memory:viz
```

Open it automatically on macOS:

```bash
pnpm memory:viz -- --open
```

The graph uses node colors for abstraction levels, edge colors for relation types, and includes stats for descendant count, expired level-0 facts, and time until the next consolidation/promotion cron.

For a live view that updates on page refresh and polls the database every 2 seconds:

```bash
pnpm memory:viz -- --serve --open
```

The live server binds to `127.0.0.1:3838` by default. Use `--port 3840` to change it.
