/* =====================================================================
   Lead campaign fields (Basic / Special Healthcare / UK Meta exports)

   DESIGN: only structural / filter columns live on Leads. Every sheet question
   (nationality, work experience answer, planned move, language test, any NEW
   column added to a sheet or Meta form...) is stored in Leads.rebuttals as JSON:
       [{"question":"nationality","answer":"British"}]
   so adding or removing a question never needs a schema change.

   PRODUCTION-SAFE for a table that already holds data:
     * every new column is NULLable with no default  -> metadata-only change,
       no table rewrite, no backfill, existing rows are untouched (all NULL)
     * only ADDs new columns; the one-off cleanup below drops obsolete columns ONLY when
       they are completely empty (a column holding data is never touched)
     * idempotent - safe to re-run
     * indexes are created ONLINE-friendly (plain nonclustered, filtered where useful)
   Take a backup before running anyway.
   ===================================================================== */
USE [ImmigrationCRM];
GO

-- Stop the whole script (all later batches) if we are not in the CRM database.
IF OBJECT_ID('dbo.Leads', 'U') IS NULL
BEGIN
    RAISERROR('dbo.Leads not found - the USE line points at the wrong database. Fix it and re-run.', 16, 1);
    SET NOEXEC ON;
END
GO

DECLARE @cols TABLE (name sysname, ddl nvarchar(200));
INSERT @cols VALUES
 -- Meta export columns (also added by meta_leads_schema.sql; skipped if present)
 ('meta_lead_id',          'NVARCHAR(50) NULL'),
 ('meta_created_time',     'DATETIME2(0) NULL'),
 ('meta_campaign_id',      'NVARCHAR(50) NULL'),
 ('meta_campaign_name',    'NVARCHAR(255) NULL'),
 ('meta_form_id',          'NVARCHAR(50) NULL'),
 ('meta_form_name',        'NVARCHAR(255) NULL'),
 ('meta_platform',         'NVARCHAR(20) NULL'),
 ('meta_is_organic',       'BIT NULL'),
 ('rebuttals',             'NVARCHAR(MAX) NULL'),

 -- Campaign classification (what the filters use)
 ('campaign_type',         'NVARCHAR(50) NULL'),      -- BASIC | SPECIAL_HEALTHCARE | UK (free text allowed)
 ('campaign_country',      'NVARCHAR(100) NULL'),     -- target market, e.g. United Kingdom, Canada, Middle East
 ('lead_date',             'DATETIME2(0) NULL');      -- "Lead Date" / "Date" column of the sheet

DECLARE @n sysname, @d nvarchar(200), @sql nvarchar(max);
DECLARE c CURSOR LOCAL FAST_FORWARD FOR SELECT name, ddl FROM @cols;
OPEN c; FETCH NEXT FROM c INTO @n, @d;
WHILE @@FETCH_STATUS = 0
BEGIN
    IF COL_LENGTH('dbo.Leads', @n) IS NULL
    BEGIN
        SET @sql = N'ALTER TABLE dbo.Leads ADD ' + QUOTENAME(@n) + N' ' + @d + N';';
        EXEC (@sql);
    END
    FETCH NEXT FROM c INTO @n, @d;
END
CLOSE c; DEALLOCATE c;
GO

-- Earlier versions of this script added one column per sheet question. Those answers now
-- live in Leads.rebuttals (JSON), so drop the old columns - but ONLY if they exist AND hold
-- no data, so nothing can be lost. Columns that contain data are left alone with a message.
DECLARE @old TABLE (name sysname);
INSERT @old VALUES ('tagging'), ('nationality'), ('total_work_experience_text'),
                   ('planned_move_timeline'), ('language_test_taken'), ('conditional_question_1'),
                   ('disposition'), ('meta_lead_status'),
                   ('email_sent'), ('first_attempt_date'), ('first_attempt_time'), ('first_attempt_status'),
                   ('second_attempt_time'), ('second_attempt_status'), ('total_dial'), ('aon_bucket'), ('aon_day');
DECLARE @col sysname, @cnt int, @stmt nvarchar(400);
DECLARE o CURSOR LOCAL FAST_FORWARD FOR SELECT name FROM @old WHERE COL_LENGTH('dbo.Leads', name) IS NOT NULL;
OPEN o; FETCH NEXT FROM o INTO @col;
WHILE @@FETCH_STATUS = 0
BEGIN
    SET @stmt = N'SELECT @n = COUNT(*) FROM dbo.Leads WHERE ' + QUOTENAME(@col) + N' IS NOT NULL';
    EXEC sp_executesql @stmt, N'@n int OUTPUT', @n = @cnt OUTPUT;
    IF @cnt = 0
    BEGIN
        SET @stmt = N'ALTER TABLE dbo.Leads DROP COLUMN ' + QUOTENAME(@col);
        EXEC (@stmt);
    END
    ELSE
        PRINT 'dbo.Leads.' + @col + ' holds data - NOT dropped. Move it into rebuttals manually.';
    FETCH NEXT FROM o INTO @col;
END
CLOSE o; DEALLOCATE o;
GO

-- rebuttals must always be valid JSON (also created by meta_leads_schema.sql)
IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_Leads_rebuttals_json')
    EXEC (N'ALTER TABLE dbo.Leads ADD CONSTRAINT CK_Leads_rebuttals_json
            CHECK (rebuttals IS NULL OR ISJSON(rebuttals) = 1);');
GO

-- Verify the columns really exist before building indexes on them.
IF COL_LENGTH('dbo.Leads', 'campaign_type') IS NULL OR COL_LENGTH('dbo.Leads', 'lead_date') IS NULL
BEGIN
    RAISERROR('Columns were not added to dbo.Leads - see the first error above. Indexes skipped.', 16, 1);
    SET NOEXEC ON;
END
GO

/* One Meta lead can never be imported twice (existing rows have NULL -> ignored) */
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_Leads_meta_lead_id' AND object_id = OBJECT_ID('dbo.Leads'))
    EXEC (N'CREATE UNIQUE NONCLUSTERED INDEX UX_Leads_meta_lead_id
        ON dbo.Leads (meta_lead_id) WHERE meta_lead_id IS NOT NULL;');
GO

/* Filter indexes (filtered => tiny while most of the 1000 existing rows are NULL) */
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Leads_campaign' AND object_id = OBJECT_ID('dbo.Leads'))
    EXEC (N'CREATE NONCLUSTERED INDEX IX_Leads_campaign
        ON dbo.Leads (campaign_type, campaign_country) INCLUDE (lead_status, assigned_to, lead_date)
        WHERE campaign_type IS NOT NULL;');
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Leads_lead_date' AND object_id = OBJECT_ID('dbo.Leads'))
    EXEC (N'CREATE NONCLUSTERED INDEX IX_Leads_lead_date ON dbo.Leads (lead_date) WHERE lead_date IS NOT NULL;');
GO

SET NOEXEC OFF;
GO

/* ---------------------------------------------------------------------
   OPTIONAL - tag the leads that are already in production.
   Existing rows have no campaign info, so nothing is guessed here.
   Two ways to fill it in:
     1. Re-upload the three Excel sheets with  ?update_existing=true  - rows are
        matched by phone/email and ONLY the empty campaign columns are filled
        (status, assignment, remarks and every other value are never overwritten).
     2. PUT /api/v1/leads/campaign/bulk-tag  for hand-picked lead ids.
   Example manual tag of everything imported from Excel so far:
   UPDATE dbo.Leads SET campaign_type = 'BASIC'
    WHERE campaign_type IS NULL AND source = 'Excel Import';
   --------------------------------------------------------------------- */
