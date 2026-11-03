-- Email module schema (SQL Server). Run once against the CRM database.

IF OBJECT_ID('dbo.EmailAccounts') IS NULL
CREATE TABLE dbo.EmailAccounts (
    account_id      INT IDENTITY(1,1) PRIMARY KEY,
    owner_user_id   INT NULL,                       -- Users.id; NULL for a shared/office mailbox
    is_shared       BIT NOT NULL DEFAULT 0,         -- shared accounts can be used by every agent
    label           NVARCHAR(100) NULL,
    display_name    NVARCHAR(150) NULL,
    email_address   NVARCHAR(255) NOT NULL,
    username        NVARCHAR(255) NOT NULL,
    password_enc    NVARCHAR(1000) NOT NULL,        -- AES-256-GCM, see services/email/crypto.js
    smtp_host       NVARCHAR(255) NOT NULL,
    smtp_port       INT NOT NULL DEFAULT 587,
    smtp_secure     BIT NOT NULL DEFAULT 0,         -- 1 = implicit TLS (465), 0 = STARTTLS
    imap_host       NVARCHAR(255) NOT NULL,
    imap_port       INT NOT NULL DEFAULT 993,
    imap_secure     BIT NOT NULL DEFAULT 1,
    signature       NVARCHAR(MAX) NULL,
    is_active       BIT NOT NULL DEFAULT 1,
    last_sync_at    DATETIME NULL,
    last_error      NVARCHAR(1000) NULL,
    created_at      DATETIME NOT NULL DEFAULT GETDATE(),
    updated_at      DATETIME NOT NULL DEFAULT GETDATE()
);

IF OBJECT_ID('dbo.EmailSyncState') IS NULL
CREATE TABLE dbo.EmailSyncState (
    account_id      INT NOT NULL,
    remote_folder   NVARCHAR(255) NOT NULL,         -- IMAP path, e.g. INBOX, [Gmail]/Spam
    uid_validity    NVARCHAR(40) NULL,
    last_uid        BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (account_id, remote_folder)
);

IF OBJECT_ID('dbo.Emails') IS NULL
CREATE TABLE dbo.Emails (
    email_id        INT IDENTITY(1,1) PRIMARY KEY,
    account_id      INT NOT NULL,
    folder          VARCHAR(20) NOT NULL,           -- INBOX | SENT | DRAFTS | SPAM | TRASH
    direction       VARCHAR(10) NOT NULL,           -- INBOUND | OUTBOUND
    status          VARCHAR(10) NOT NULL DEFAULT 'RECEIVED',  -- RECEIVED | SENT | DRAFT
    message_id      NVARCHAR(500) NULL,
    in_reply_to     NVARCHAR(500) NULL,
    [references]    NVARCHAR(MAX) NULL,
    thread_id       NVARCHAR(500) NULL,
    from_address    NVARCHAR(255) NULL,
    from_name       NVARCHAR(255) NULL,
    to_addresses    NVARCHAR(MAX) NULL,
    cc_addresses    NVARCHAR(MAX) NULL,
    bcc_addresses   NVARCHAR(MAX) NULL,
    subject         NVARCHAR(998) NULL,
    body_text       NVARCHAR(MAX) NULL,
    body_html       NVARCHAR(MAX) NULL,
    snippet         NVARCHAR(300) NULL,
    has_attachments BIT NOT NULL DEFAULT 0,
    is_read         BIT NOT NULL DEFAULT 0,
    is_starred      BIT NOT NULL DEFAULT 0,
    lead_id         INT NULL,
    case_id         INT NULL,
    sent_by_user_id INT NULL,
    remote_folder   NVARCHAR(255) NULL,
    remote_uid      BIGINT NULL,
    email_date      DATETIME NOT NULL DEFAULT GETDATE(),
    deleted_at      DATETIME NULL,                  -- set when removed from TRASH
    created_at      DATETIME NOT NULL DEFAULT GETDATE()
);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_Emails_Account_Message')
CREATE UNIQUE INDEX UX_Emails_Account_Message ON dbo.Emails(account_id, message_id) WHERE message_id IS NOT NULL;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Emails_Folder')
CREATE INDEX IX_Emails_Folder ON dbo.Emails(account_id, folder, email_date DESC);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Emails_Lead')
CREATE INDEX IX_Emails_Lead ON dbo.Emails(lead_id, email_date DESC);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Emails_Case')
CREATE INDEX IX_Emails_Case ON dbo.Emails(case_id, email_date DESC);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Emails_Thread')
CREATE INDEX IX_Emails_Thread ON dbo.Emails(thread_id);

IF OBJECT_ID('dbo.EmailAttachments') IS NULL
CREATE TABLE dbo.EmailAttachments (
    attachment_id   INT IDENTITY(1,1) PRIMARY KEY,
    email_id        INT NOT NULL REFERENCES dbo.Emails(email_id) ON DELETE CASCADE,
    file_name       NVARCHAR(255) NOT NULL,
    content_type    NVARCHAR(150) NULL,
    size_bytes      INT NOT NULL DEFAULT 0,
    storage_name    NVARCHAR(255) NOT NULL,         -- file under private/email-attachments
    created_at      DATETIME NOT NULL DEFAULT GETDATE()
);
