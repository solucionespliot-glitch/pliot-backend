import { pool } from './db';

type Operator = 'gt' | 'lt' | 'gte' | 'lte';

function evaluateCondition(value: number, operator: Operator, threshold: number): boolean {
  switch (operator) {
    case 'gt':  return value > threshold;
    case 'lt':  return value < threshold;
    case 'gte': return value >= threshold;
    case 'lte': return value <= threshold;
  }
}

/**
 * Evaluate alarm rules for a device after telemetry ingestion.
 * Called fire-and-forget from ingest routes — never blocks the response.
 *
 * Logic per rule:
 *  - Condition met + no active event  → insert new alarm_event
 *  - Condition not met + active event → auto-resolve (set resolved_at = NOW())
 *  - Anything else                    → no-op
 */
export function evaluateAlarms(deviceUuid: string, normFields: Record<string, unknown>): void {
  _evaluate(deviceUuid, normFields).catch((err) =>
    console.error('[alarms] evaluation error:', err),
  );
}

async function _evaluate(deviceUuid: string, normFields: Record<string, unknown>): Promise<void> {
  // Fetch all enabled rules that match this device.
  // A rule matches if its device_id/site_id/organization_id are consistent with
  // the device's own org and site. NULL means "applies to all" at that level.
  const { rows: rules } = await pool.query<{
    id: string;
    metric: string;
    operator: Operator;
    threshold: number;
  }>(
    `SELECT r.id, r.metric, r.operator, r.threshold
       FROM alarm_rules r
       JOIN devices d ON d.id = $1
      WHERE r.enabled = true
        AND r.organization_id = d.organization_id
        AND (r.device_id IS NULL OR r.device_id = $1)
        AND (r.site_id   IS NULL OR r.site_id   = d.site_id)`,
    [deviceUuid],
  );

  if (rules.length === 0) return;

  for (const rule of rules) {
    // Skip if this telemetry packet doesn't include the metric this rule watches
    const rawValue = normFields[rule.metric];
    if (rawValue === undefined || rawValue === null) continue;

    const value = Number(rawValue);
    if (isNaN(value)) continue;

    const conditionMet = evaluateCondition(value, rule.operator, rule.threshold);

    // Check for an existing unresolved event for this rule + device
    const { rows: active } = await pool.query<{ id: string }>(
      `SELECT id FROM alarm_events
        WHERE rule_id = $1 AND device_id = $2 AND resolved_at IS NULL
        LIMIT 1`,
      [rule.id, deviceUuid],
    );

    const hasActive = active.length > 0;

    if (conditionMet && !hasActive) {
      // Threshold crossed and no open event → fire new alarm
      await pool.query(
        `INSERT INTO alarm_events (rule_id, device_id, metric, value, threshold, operator)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [rule.id, deviceUuid, rule.metric, value, rule.threshold, rule.operator],
      );
    } else if (!conditionMet && hasActive) {
      // Value returned to normal range → auto-resolve the open event
      await pool.query(
        `UPDATE alarm_events SET resolved_at = NOW()
          WHERE rule_id = $1 AND device_id = $2 AND resolved_at IS NULL`,
        [rule.id, deviceUuid],
      );
    }
  }
}
