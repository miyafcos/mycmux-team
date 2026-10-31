SELECT
    (SELECT value FROM index_state WHERE key='report_database_id'),
    (SELECT value FROM index_state WHERE key='report_revision')
