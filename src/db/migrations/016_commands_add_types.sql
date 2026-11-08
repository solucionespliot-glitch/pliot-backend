-- Migration 016: extend commands.command_type check constraint
-- Adds relay control command types allowed from the dashboard.
-- pulseRelay:  turns a relay ON for a fixed duration (manual pulse from dashboard)
-- stopRelay:   immediately turns a relay OFF and clears any active pulse timer
-- pauseRelay:  turns relay OFF and blocks behavior controllers until resumeRelay
-- resumeRelay: re-enables behavior controllers for a paused relay

ALTER TABLE commands DROP CONSTRAINT commands_command_type_check;

ALTER TABLE commands ADD CONSTRAINT commands_command_type_check
  CHECK (command_type IN (
    'setRelays',
    'setConfig',
    'requestSync',
    'syncEtpForecast',
    'test',
    'pulseRelay',
    'stopRelay',
    'pauseRelay',
    'resumeRelay'
  ));
