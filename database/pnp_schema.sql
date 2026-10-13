-- PNP (Provincial Nominee Program) module schema (SQL Server). Run once against the CRM database.

IF OBJECT_ID('dbo.PNPPrograms') IS NULL
CREATE TABLE dbo.PNPPrograms (
    pnp_program_id  INT IDENTITY(1,1) PRIMARY KEY,
    province_code   VARCHAR(5) NOT NULL,            -- e.g. ON, BC, AB, SK, MB
    province_name   NVARCHAR(100) NOT NULL,
    program_name    NVARCHAR(255) NOT NULL,         -- e.g. Human Capital Priority Stream
    stream_type     NVARCHAR(100) NULL,             -- e.g. Express Entry, Base, Employer-driven
    description     NVARCHAR(MAX) NULL,
    is_active       BIT NOT NULL DEFAULT 1,
    created_by      INT NULL,
    created_at      DATETIME NOT NULL DEFAULT GETDATE(),
    updated_at      DATETIME NOT NULL DEFAULT GETDATE(),
    CONSTRAINT UQ_PNPPrograms_province_program UNIQUE (province_code, program_name)
);

-- Join table: one case can be linked to many PNP programs (and a program to many cases).
IF OBJECT_ID('dbo.CasePNPPrograms') IS NULL
CREATE TABLE dbo.CasePNPPrograms (
    case_pnp_id     INT IDENTITY(1,1) PRIMARY KEY,
    case_id         INT NOT NULL,
    pnp_program_id  INT NOT NULL,
    pnp_status      VARCHAR(30) NOT NULL DEFAULT 'Considering',
                                                    -- Considering | Applied | Nominated | Refused | Withdrawn
    applied_date    DATETIME NULL,
    decision_date   DATETIME NULL,
    remarks         NVARCHAR(MAX) NULL,
    created_by      INT NULL,
    created_at      DATETIME NOT NULL DEFAULT GETDATE(),
    updated_at      DATETIME NOT NULL DEFAULT GETDATE(),
    CONSTRAINT FK_CasePNPPrograms_Case FOREIGN KEY (case_id) REFERENCES dbo.ImmigrationCases(case_id) ON DELETE CASCADE,
    CONSTRAINT FK_CasePNPPrograms_Program FOREIGN KEY (pnp_program_id) REFERENCES dbo.PNPPrograms(pnp_program_id),
    CONSTRAINT UQ_CasePNPPrograms_case_program UNIQUE (case_id, pnp_program_id)
);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_CasePNPPrograms_program')
CREATE INDEX IX_CasePNPPrograms_program ON dbo.CasePNPPrograms (pnp_program_id);
