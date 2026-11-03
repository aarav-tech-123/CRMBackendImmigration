/* =====================================================================
   Lead campaign fields (Basic / Special Healthcare / UK Meta exports)

   PRODUCTION-SAFE for a table that already holds data:
     * every new column is NULLable with no default  -> metadata-only change,
       no table rewrite, no backfill, existing rows are untouched (all NULL)
     * only ADDs - nothing is altered, dropped or renamed
     * idempotent - safe to re-run
     * indexes are created ONLINE-friendly (plain nonclustered, filtered where useful)
   Take a backup before running anyway.
   ===================================================================== */
USE [ImmigrationCRM];
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
 ('lead_date',             'DATETIME2(0) NULL'),      -- "Lead Date" / "Date" column of the sheet

 -- Lead profile answers
 ('nationality',           'NVARCHAR(100) NULL'),     -- UK sheet
 ('total_work_experience_text', 'NVARCHAR(100) NULL'),-- raw answer, e.g. "3-5 years" (numeric value lives in LeadWorkExperience)
 ('planned_move_timeline', 'NVARCHAR(150) NULL'),     -- Special Healthcare: when planning to move
 ('language_test_taken',   'NVARCHAR(150) NULL'),     -- Special Healthcare: approved English/French test
 ('conditional_question_1', 'NVARCHAR(500) NULL'),    -- Special Healthcare
 -- (Disposition from the sheet is stored as the CRM status: Leads.lead_status)
 ('tagging',               'NVARCHAR(100) NULL');     -- UK sheet

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

/* One Meta lead can never be imported twice (existing rows have NULL -> ignored) */
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_Leads_meta_lead_id' AND object_id = OBJECT_ID('dbo.Leads'))
    CREATE UNIQUE NONCLUSTERED INDEX UX_Leads_meta_lead_id
        ON dbo.Leads (meta_lead_id) WHERE meta_lead_id IS NOT NULL;
GO

/* Filter indexes (filtered => tiny while most of the 1000 existing rows are NULL) */
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Leads_campaign' AND object_id = OBJECT_ID('dbo.Leads'))
    CREATE NONCLUSTERED INDEX IX_Leads_campaign
        ON dbo.Leads (campaign_type, campaign_country) INCLUDE (lead_status, assigned_to, lead_date)
        WHERE campaign_type IS NOT NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Leads_lead_date' AND object_id = OBJECT_ID('dbo.Leads'))
    CREATE NONCLUSTERED INDEX IX_Leads_lead_date ON dbo.Leads (lead_date) WHERE lead_date IS NOT NULL;
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
