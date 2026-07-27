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




app.get('/api/status', (req, res) => {
  res.json({ status: 'API is running' });
})








// Default route
app.get(`/`, (req, res) => res.send("Immigration CRM Backend Running"));

app.listen(PORT, () => console.log(`Server running on  http://localhost:${PORT}`));





