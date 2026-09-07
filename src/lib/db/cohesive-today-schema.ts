export const COHESIVE_TODAY_PREFERENCES_SCHEMA_SQL = `
  ALTER TABLE omni_today_preferences
    ADD COLUMN IF NOT EXISTS visible_sections TEXT[] NOT NULL DEFAULT ARRAY[
      'focus', 'agenda', 'approvals', 'customers', 'active_agents',
      'work', 'memory', 'conversations', 'consumption'
    ]::TEXT[];

  ALTER TABLE omni_today_preferences
    DROP CONSTRAINT IF EXISTS omni_today_preferences_visible_sections_valid;
  ALTER TABLE omni_today_preferences
    ADD CONSTRAINT omni_today_preferences_visible_sections_valid CHECK (
      cardinality(visible_sections) BETWEEN 1 AND 9
      AND visible_sections <@ ARRAY[
        'focus', 'agenda', 'approvals', 'customers', 'active_agents',
        'work', 'memory', 'conversations', 'consumption'
      ]::TEXT[]
    );
`;
