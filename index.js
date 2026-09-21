process.on('uncaughtException', (err) => {
    console.error('UNCAUGHT EXCEPTION:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('UNHANDLED REJECTION:', reason);
});

import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import { poolPromise } from "./config/db.js";
import authRoutes from "./routes/auth.routes.js";
import centerRoutes from './routes/center.routes.js'
import leadsRoutes from "./routes/leads.routes.js";
import assignmentsRoutes from "./routes/assignments.routes.js";
import timelineRoutes from "./routes/timeline.routes.js";
import fileStatusMaster from "./routes/fileStatusMaster.routes.js"
import leadStatusMaster from "./routes/utils/leadStatus.routes.js"
import leadAddressRoutes from "./routes/leadAddress.routes.js"  
import leadCanadianRelationRoutes from "./routes/leadCanadianRelation.routes.js"
import leadEducationRoutes from "./routes/leadEducation.routes.js"
import leadPersonalInformationRoutes from "./routes/leadPersonalInformation.routes.js"
import leadWorkExperienceRoutes from "./routes/leadWorkExperience.routes.js"
import immigrationProgram from "./routes/utils/immigrationProgram.routes.js"
import paymentTypes from "./routes/utils/paymentType.routes.js"
import immigrationCaseRoutes from "./routes/immigrationCase.routes.js"
import caseWorkflowRoutes from "./routes/caseWorkflow.routes.js"
import caseTaskRoutes from "./routes/caseTask.routes.js"
import taskStatusRoutes from "./routes/utils/taskStatus.routes.js"
import notesRoutes from "./routes/notes.routes.js"
import followUpRoutes from "./routes/followUp.routes.js"
import notificationRoutes from "./routes/notification.routes.js"
import reminderRoutes from "./routes/reminder.routes.js"
import documentTypeRoutes from "./routes/utils/documentType.routes.js"
import documentStatusRoutes from "./routes/utils/documentStatus.routes.js"
import caseDocumentRequirementRoutes from "./routes/caseDocumentRequirement.routes.js"
import caseDocumentRoutes from "./routes/caseDocument.routes.js"
import immigrationPipelineRoutes from "./routes/immigrationPipeline.routes.js"
import immigrationStatsRoutes from "./routes/dashboardStats.routes.js"

import path from "path";

dotenv.config();
const app = express();

// app.use(cors());
app.use(express.json());



app.use(cors('*'))

// API_URL
const api = process.env.API_URL
const __dirname = process.cwd();
app.use("/uploads", express.static(path.join(__dirname, "uploads")));
app.use(
  '/api/v1/uploads',
  express.static(path.join(process.cwd(), 'uploads'))
);

const PORT = process.env.PORT || 8080;


// Test DB connection
poolPromise.then(() => console.log("SQL Connection Ready"));

// Routes
app.use(`${api}/auth`, authRoutes);
app.use(`${api}/centers`, centerRoutes)
app.use(`${api}/leads`, leadsRoutes);
app.use(`${api}/assignments`, assignmentsRoutes);
app.use(`${api}/status`, timelineRoutes);
app.use(`${api}/file-status`, fileStatusMaster);

app.use(`${api}/lead-address`, leadAddressRoutes)
app.use(`${api}/lead-canadian-relation`, leadCanadianRelationRoutes)
app.use(`${api}/lead-education`, leadEducationRoutes)
app.use(`${api}/lead-personal-information`, leadPersonalInformationRoutes)
app.use(`${api}/lead-work-experience`, leadWorkExperienceRoutes)
app.use(`${api}/immigration/pipeline`, immigrationPipelineRoutes)
app.use(`${api}/immigration/dashboard`, immigrationStatsRoutes)

// Utils Endpoints
app.use(`${api}/immigration-program`, immigrationProgram)
app.use(`${api}/payment-types`, paymentTypes)
app.use(`${api}/lead-status`, leadStatusMaster)
app.use(`${api}/task-status`, taskStatusRoutes)
app.use(`${api}/document-types`, documentTypeRoutes)
app.use(`${api}/document-status`, documentStatusRoutes)


app.use(`${api}/immigration-cases`, immigrationCaseRoutes)
app.use(`${api}/immigration/workflow`, caseWorkflowRoutes)
app.use(`${api}/immigration-cases/task`, caseTaskRoutes)
app.use(`${api}/immigration-cases/document-requirements`, caseDocumentRequirementRoutes)
app.use(`${api}/immigration-cases/documents`, caseDocumentRoutes)
app.use(`${api}/notes`, notesRoutes)
app.use(`${api}/followups`, followUpRoutes)
app.use(`${api}/notifications`, notificationRoutes)
app.use(`${api}/reminders`, reminderRoutes)



app.get('/api/status', (req, res) => {
  res.json({ status: 'API is running' });
})








// Default route
app.get(`/`, (req, res) => res.send("Immigration CRM Backend Running"));

app.listen(PORT, () => console.log(`Server running on  http://localhost:${PORT}`));





