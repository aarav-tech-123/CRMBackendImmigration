/* =====================================================================
   Meta Lead Ads -> ImmigrationCRM.dbo.Leads
   Requires DB compatibility level >= 130 (OPENJSON / ISJSON / FOR JSON).
   Safe to re-run (idempotent). Review the TODO markers before production.
   ===================================================================== */
USE [ImmigrationCRM];
GO

/* ---------------------------------------------------------------------
   1. New columns on Leads (all NULLable => metadata-only, no table rewrite)
   --------------------------------------------------------------------- */
DECLARE @cols TABLE (name sysname, ddl nvarchar(200));
INSERT @cols VALUES
 ('meta_lead_id',         'NVARCHAR(50) NULL'),
 ('meta_created_time',    'DATETIME2(0) NULL'),
 ('meta_ad_id',           'NVARCHAR(50) NULL'),
 ('meta_ad_name',         'NVARCHAR(255) NULL'),
 ('meta_adset_id',        'NVARCHAR(50) NULL'),
 ('meta_adset_name',      'NVARCHAR(255) NULL'),
 ('meta_campaign_id',     'NVARCHAR(50) NULL'),
 ('meta_campaign_name',   'NVARCHAR(255) NULL'),
 ('meta_form_id',         'NVARCHAR(50) NULL'),
 ('meta_form_name',       'NVARCHAR(255) NULL'),
 ('meta_platform',        'NVARCHAR(20) NULL'),      -- fb / ig
 ('meta_is_organic',      'BIT NULL'),
 ('meta_inbox_url',       'NVARCHAR(500) NULL'),
 ('rebuttals',            'NVARCHAR(MAX) NULL');     -- JSON: [{"question":..,"answer":..}]

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

IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_Leads_rebuttals_json')
    ALTER TABLE dbo.Leads ADD CONSTRAINT CK_Leads_rebuttals_json
        CHECK (rebuttals IS NULL OR ISJSON(rebuttals) = 1);
GO

-- Hard guarantee that one Meta lead can never be imported twice
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_Leads_meta_lead_id' AND object_id = OBJECT_ID('dbo.Leads'))
    CREATE UNIQUE NONCLUSTERED INDEX UX_Leads_meta_lead_id
        ON dbo.Leads (meta_lead_id) WHERE meta_lead_id IS NOT NULL;
GO

/* ---------------------------------------------------------------------
   2. Staging table. Your Meta webhook/Graph API job inserts ONE row per
      lead with the whole lead as a flat JSON object in raw_json, e.g.
      {"id":"123","created_time":"2026-10-21T10:00:00+0000","first_name":"A",
       "phone_number":"p:+919999999999","email":"a@b.com",
       "what_is_your_current_healthcare_profession?":"Nurse", ...}
      (same keys as the CSV headers). Nothing is lost if Meta adds a form
      question later: unknown keys flow straight into Leads.rebuttals.
   --------------------------------------------------------------------- */
IF OBJECT_ID('dbo.Meta_Leads_Staging') IS NULL
CREATE TABLE dbo.Meta_Leads_Staging
(
    stg_id          BIGINT IDENTITY(1,1) PRIMARY KEY,
    batch_id        UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID(),
    received_at     DATETIME2(0)     NOT NULL DEFAULT SYSDATETIME(),
    raw_json        NVARCHAR(MAX)    NOT NULL CHECK (ISJSON(raw_json) = 1),

    -- filled by usp_ImportMetaLeads
    meta_lead_id    NVARCHAR(50)  NULL,
    norm_phone      VARCHAR(15)   NULL,      -- last 10 digits
    norm_email      NVARCHAR(255) NULL,      -- lower/trimmed

    import_status   VARCHAR(12)   NOT NULL DEFAULT 'Pending', -- Pending/Ready/Inserted/Duplicate/Error
    duplicate_reason VARCHAR(30)  NULL,      -- MetaId / Phone / Email / InBatch
    lead_id         INT           NULL,      -- Leads.lead_id (inserted or matched duplicate)
    error_message   NVARCHAR(500) NULL,
    processed_at    DATETIME2(0)  NULL
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_MetaStg_status' AND object_id=OBJECT_ID('dbo.Meta_Leads_Staging'))
    CREATE INDEX IX_MetaStg_status ON dbo.Meta_Leads_Staging (import_status) INCLUDE (batch_id);
GO

/* ---------------------------------------------------------------------
   3. Import procedure: parse -> validate -> de-duplicate -> insert
   --------------------------------------------------------------------- */
-- Meta leads are always inserted unassigned (assigned_to = NULL); assign them from the CRM.
CREATE OR ALTER PROCEDURE dbo.usp_ImportMetaLeads
AS
BEGIN
    SET NOCOUNT ON; SET XACT_ABORT ON;

    DECLARE @started DATETIME2(0) = SYSDATETIME();
    DECLARE @default_status INT = (SELECT TOP (1) id FROM dbo.LeadStatuses ORDER BY sort_order);
    IF @default_status IS NULL THROW 50001, 'LeadStatuses is empty - add a default status first.', 1;

    BEGIN TRAN;

    -- one import at a time (webhook + manual run could overlap)
    DECLARE @lock INT;
    EXEC @lock = sp_getapplock @Resource='usp_ImportMetaLeads', @LockMode='Exclusive',
                               @LockOwner='Transaction', @LockTimeout=30000;
    IF @lock < 0 THROW 50002, 'Another Meta import is running.', 1;

    -- 3a. Parse the known fields out of the JSON
    UPDATE s SET
        meta_lead_id = REPLACE(JSON_VALUE(raw_json, '$.id'), 'l:', ''),
        norm_email   = NULLIF(LOWER(LTRIM(RTRIM(JSON_VALUE(raw_json, '$.email')))), ''),
        norm_phone   = NULLIF(RIGHT(
                          REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
                          ISNULL(JSON_VALUE(raw_json, '$.phone_number'), ''),
                          'p:',''),'+',''),' ',''),'-',''),'(',''),')',''), 10), '')
    FROM dbo.Meta_Leads_Staging s
    WHERE import_status = 'Pending';

    -- 3b. Reject rows we cannot contact / identify
    UPDATE dbo.Meta_Leads_Staging
       SET import_status='Error', error_message='No Meta id, or no phone and no email',
           processed_at=SYSDATETIME()
     WHERE import_status='Pending'
       AND (meta_lead_id IS NULL OR (norm_phone IS NULL AND norm_email IS NULL));

    -- 3c. Duplicates against existing Leads (Meta id > phone > email)
    UPDATE s SET import_status='Duplicate', processed_at=SYSDATETIME(),
                 duplicate_reason = m.reason, lead_id = m.lead_id
    FROM dbo.Meta_Leads_Staging s
    CROSS APPLY (
        SELECT TOP (1) l.lead_id, x.reason
        FROM dbo.Leads l
        CROSS APPLY (SELECT CASE
              WHEN l.meta_lead_id = s.meta_lead_id THEN 'MetaId'
              WHEN s.norm_phone IS NOT NULL AND s.norm_phone IN
                   (RIGHT(REPLACE(REPLACE(REPLACE(ISNULL(l.mobile_number,''),'+',''),' ',''),'-',''),10),
                    RIGHT(REPLACE(REPLACE(REPLACE(ISNULL(l.alt_phone_number,''),'+',''),' ',''),'-',''),10))
                   THEN 'Phone'
              WHEN s.norm_email IS NOT NULL AND s.norm_email IN
                   (LOWER(LTRIM(RTRIM(l.email_address))), LOWER(LTRIM(RTRIM(l.alt_email))))
                   THEN 'Email' END AS reason) x
        WHERE x.reason IS NOT NULL
        ORDER BY CASE x.reason WHEN 'MetaId' THEN 1 WHEN 'Phone' THEN 2 ELSE 3 END
    ) m
    WHERE s.import_status = 'Pending';

    -- 3d. Duplicates inside this run (keep the earliest row)
    ;WITH d AS (
        SELECT import_status, duplicate_reason, processed_at,
               ROW_NUMBER() OVER (PARTITION BY COALESCE(meta_lead_id, '')       ORDER BY stg_id) r_id,
               ROW_NUMBER() OVER (PARTITION BY COALESCE(norm_phone, CONCAT('~', stg_id)) ORDER BY stg_id) r_ph,
               ROW_NUMBER() OVER (PARTITION BY COALESCE(norm_email, CONCAT('~', stg_id)) ORDER BY stg_id) r_em
        FROM dbo.Meta_Leads_Staging WHERE import_status = 'Pending')
    UPDATE d SET import_status='Duplicate', duplicate_reason='InBatch', processed_at=SYSDATETIME()
    WHERE r_id > 1 OR r_ph > 1 OR r_em > 1;

    UPDATE dbo.Meta_Leads_Staging SET import_status='Ready' WHERE import_status='Pending';

    -- 3e. Insert new leads.
    --     rebuttals = every key in the JSON that is NOT already a dedicated column,
    --     so future form questions land here automatically.
    INSERT dbo.Leads
    (   first_name, last_name, full_name, mobile_number, alt_phone_number,
        email_address, source, lead_status, is_converted,
        is_connected, created_at, updated_at,
        english_proficiency_level, income_band_per_month,
        meta_lead_id, meta_created_time, meta_ad_id, meta_ad_name, meta_adset_id, meta_adset_name,
        meta_campaign_id, meta_campaign_name, meta_form_id, meta_form_name, meta_platform,
        meta_is_organic, meta_inbox_url,
        rebuttals )
    SELECT
        ISNULL(j.first_name, j.full_name), ISNULL(j.last_name, ''),
        LTRIM(RTRIM(COALESCE(NULLIF(CONCAT(j.first_name,' ',j.last_name),' '), j.full_name))),
        ISNULL(REPLACE(REPLACE(j.phone,'p:',''),' ',''), ''),   -- mobile_number is NOT NULL
        REPLACE(REPLACE(j.work_phone,'p:',''),' ',''),
        s.norm_email,
        'Meta Ads', @default_status, 0,
        0, SYSDATETIME(), SYSDATETIME(),
        j.english_test, j.income_band,
        s.meta_lead_id, TRY_CONVERT(DATETIME2(0), j.created_time),
        j.ad_id, j.ad_name, j.adset_id, j.adset_name, j.campaign_id, j.campaign_name,
        j.form_id, j.form_name, j.platform,
        CASE LOWER(j.is_organic) WHEN 'true' THEN 1 WHEN 'false' THEN 0 END, j.inbox_url,
        (SELECT o.[key] AS question, o.[value] AS answer
           FROM OPENJSON(s.raw_json) o
          WHERE o.[key] NOT IN ('id','created_time','ad_id','ad_name','adset_id','adset_name',
                                'campaign_id','campaign_name','form_id','form_name','is_organic',
                                'platform','inbox_url','first_name','last_name','full_name',
                                'phone_number','work_phone_number','email',
                                'income_band_(per_month)')
            AND NULLIF(o.[value], '') IS NOT NULL
          FOR JSON PATH)
    FROM dbo.Meta_Leads_Staging s
    CROSS APPLY OPENJSON(s.raw_json) WITH (
        created_time  NVARCHAR(40)  '$.created_time',
        ad_id NVARCHAR(50) '$.ad_id', ad_name NVARCHAR(255) '$.ad_name',
        adset_id NVARCHAR(50) '$.adset_id', adset_name NVARCHAR(255) '$.adset_name',
        campaign_id NVARCHAR(50) '$.campaign_id', campaign_name NVARCHAR(255) '$.campaign_name',
        form_id NVARCHAR(50) '$.form_id', form_name NVARCHAR(255) '$.form_name',
        platform NVARCHAR(20) '$.platform', is_organic NVARCHAR(10) '$.is_organic',
        inbox_url NVARCHAR(500) '$.inbox_url',
        first_name NVARCHAR(100) '$.first_name', last_name NVARCHAR(100) '$.last_name',
        full_name NVARCHAR(200) '$.full_name',
        phone NVARCHAR(50) '$.phone_number', work_phone NVARCHAR(50) '$.work_phone_number',
        income_band NVARCHAR(100) '$."income_band_(per_month)"',
        english_test NVARCHAR(200) '$."have_you_taken_an_approved_english_or_french_language_test?"'
    ) j
    WHERE s.import_status = 'Ready';

    -- 3f. lead_number uses the same format as the rest of the CRM: L<id>-DDMMYY
    UPDATE l SET lead_number = CONCAT('L', l.lead_id, '-', FORMAT(SYSDATETIME(), 'ddMMyy'))
    FROM dbo.Leads l
    JOIN dbo.Meta_Leads_Staging s ON s.meta_lead_id = l.meta_lead_id AND s.import_status = 'Ready'
    WHERE l.lead_number IS NULL;

    -- 3g. Link staging rows to the new Leads rows
    UPDATE s SET import_status='Inserted', lead_id=l.lead_id, processed_at=SYSDATETIME()
    FROM dbo.Meta_Leads_Staging s
    JOIN dbo.Leads l ON l.meta_lead_id = s.meta_lead_id
    WHERE s.import_status = 'Ready';

    COMMIT;

    SELECT import_status, COUNT(*) AS cnt
      FROM dbo.Meta_Leads_Staging
     WHERE processed_at >= @started
     GROUP BY import_status;
END
GO

/* ---------------------------------------------------------------------
   4. Usage / smoke test (run on a non-prod copy first)
   ---------------------------------------------------------------------
INSERT dbo.Meta_Leads_Staging (raw_json) VALUES (N'{
  "id":"l:1234567890","created_time":"2026-10-21T10:00:00+0000","platform":"fb",
  "first_name":"Test","last_name":"Nurse","phone_number":"p:+919999999999","email":"test@example.com",
  "income_band_(per_month)":"50k-1L",
  "what_is_your_current_healthcare_profession?":"Nurse",
  "how_many_years_of_relevant_work_experience_do_you_have?":"3-5",
  "some_new_question_added_later":"yes"}');
EXEC dbo.usp_ImportMetaLeads;
SELECT lead_id, full_name, rebuttals FROM dbo.Leads WHERE meta_lead_id = '1234567890';
*/
