CREATE INDEX `tasks_schedule_id_idx`
  ON `tasks` (json_extract(`metadata`, '$.scheduleId'))
  WHERE `origin` = 'schedule';
