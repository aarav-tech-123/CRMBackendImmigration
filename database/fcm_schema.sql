-- FCM push notification schema (SQL Server). Run once against the CRM database.

IF OBJECT_ID('dbo.UserDeviceTokens') IS NULL
CREATE TABLE dbo.UserDeviceTokens (
    token_id      INT IDENTITY(1,1) PRIMARY KEY,
    user_id       INT NOT NULL,                      -- Users.id
    fcm_token     NVARCHAR(512) NOT NULL,
    platform      VARCHAR(20) NOT NULL DEFAULT 'web',
    user_agent    NVARCHAR(500) NULL,
    created_at    DATETIME NOT NULL DEFAULT GETDATE(),
    last_seen_at  DATETIME NOT NULL DEFAULT GETDATE(),
    CONSTRAINT UQ_UserDeviceTokens_token UNIQUE (fcm_token),
    CONSTRAINT FK_UserDeviceTokens_User FOREIGN KEY (user_id) REFERENCES dbo.Users(id) ON DELETE CASCADE
);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_UserDeviceTokens_user' AND object_id = OBJECT_ID('dbo.UserDeviceTokens'))
CREATE INDEX IX_UserDeviceTokens_user ON dbo.UserDeviceTokens (user_id);

-- Speeds up the reminder scheduler's "due and unsent" lookup.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Reminders_due' AND object_id = OBJECT_ID('dbo.Reminders'))
CREATE INDEX IX_Reminders_due ON dbo.Reminders (is_sent, status, remind_at);
