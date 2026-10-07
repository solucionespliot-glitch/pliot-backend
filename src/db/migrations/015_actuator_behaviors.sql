-- Migration: 015_actuator_behaviors
-- Description: Replace the old behavior_type values with the new extensible
--              behavior system. Renames vpd_triggered → vpd, manual_only → manual,
--              drops unused legacy values (direct, pulse_cycle, timed_on).
--              Also drops the actuator_type filter dependency from the firmware
--              snapshot by making behavior_type the single source of truth for
--              control logic.

-- Step 1: Drop the old CHECK constraint on behavior_type
ALTER TABLE actuators
  DROP CONSTRAINT IF EXISTS actuators_behavior_type_check;

-- Step 2: Rename existing values that have a direct equivalent
UPDATE actuators SET behavior_type = 'vpd'    WHERE behavior_type = 'vpd_triggered';
UPDATE actuators SET behavior_type = 'manual' WHERE behavior_type = 'manual_only';

-- Step 3: Null out legacy values with no equivalent (direct, pulse_cycle, timed_on).
-- These were never used in production — set to manual so the relay is safe.
UPDATE actuators
  SET behavior_type = 'manual'
  WHERE behavior_type IN ('direct', 'pulse_cycle', 'timed_on');

-- Step 4: Add the new CHECK constraint with the full set of behavior types
ALTER TABLE actuators
  ADD CONSTRAINT actuators_behavior_type_check
  CHECK (behavior_type IN ('vpd', 'schedule', 'irrigation', 'temperature', 'manual'));
