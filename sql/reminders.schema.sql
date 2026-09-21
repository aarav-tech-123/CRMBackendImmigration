-- Reminders: a scheduled nudge for a user about a Lead (and, once converted,
-- its ImmigrationCase). Distinct from FollowUps (a task someone must perform)
-- and Notifications (an inbox item, usually generated *from* something else,
-- e.g. a reminder firing). is_sent/sent_at are here so a future scheduler/cron
-- job can pick up due reminders (remind_at <= GETDATE() AND is_sent = 0),
-- push a Notification via the existing Notifications table, and flip is_sent.

CREATE TABLE dbo.Reminders (
    reminder_id     INT IDENTITY(1,1)      NOT NULL,
    lead_id         INT                    NOT NULL,
    case_id         INT                    NULL,
    user_id         INT                    NOT NULL, -- who the reminder is for
    created_by      INT                    NOT NULL, -- who set it
    title           NVARCHAR(255)          NOT NULL,
    description     NVARCHAR(MAX)          NULL,
    remind_at       DATETIME               NOT NULL,
    priority        VARCHAR(20)            NOT NULL CONSTRAINT DF_Reminders_priority DEFAULT ('Medium'),
    status          VARCHAR(20)            NOT NULL CONSTRAINT DF_Reminders_status DEFAULT ('Pending'), -- Pending | Completed | Dismissed
    is_sent         BIT                    NOT NULL CONSTRAINT DF_Reminders_is_sent DEFAULT (0),
    sent_at         DATETIME               NULL,
    completed_at    DATETIME               NULL,
    remarks         NVARCHAR(MAX)          NULL,
    created_at      DATETIME               NOT NULL CONSTRAINT DF_Reminders_created_at DEFAULT (GETDATE()),
    updated_at      DATETIME               NOT NULL CONSTRAINT DF_Reminders_updated_at DEFAULT (GETDATE()),

    CONSTRAINT PK_Reminders PRIMARY KEY CLUSTERED (reminder_id),

    CONSTRAINT FK_Reminders_Leads
        FOREIGN KEY (lead_id) REFERENCES dbo.Leads (lead_id),
    CONSTRAINT FK_Reminders_ImmigrationCases
        FOREIGN KEY (case_id) REFERENCES dbo.ImmigrationCases (case_id),
    CONSTRAINT FK_Reminders_Users_user_id
        FOREIGN KEY (user_id) REFERENCES dbo.Users (id),
    CONSTRAINT FK_Reminders_Users_created_by
        FOREIGN KEY (created_by) REFERENCES dbo.Users (id),

    CONSTRAINT CK_Reminders_priority CHECK (priority IN ('Low', 'Medium', 'High', 'Urgent')),
    CONSTRAINT CK_Reminders_status CHECK (status IN ('Pending', 'Completed', 'Dismissed'))
);
GO

-- "My due/upcoming reminders" is the hot query path.
CREATE INDEX IX_Reminders_user_status_remind_at
    ON dbo.Reminders (user_id, status, remind_at);

CREATE INDEX IX_Reminders_lead_id ON dbo.Reminders (lead_id);
CREATE INDEX IX_Reminders_case_id ON dbo.Reminders (case_id);

-- For a future dispatcher job: due, unsent, still-pending reminders.
CREATE INDEX IX_Reminders_dispatch
    ON dbo.Reminders (is_sent, remind_at)
    WHERE status = 'Pending';
GO
