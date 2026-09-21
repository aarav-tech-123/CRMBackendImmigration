import express from "express"
import { verifyToken, authorize } from "../../middleware/auth.middleware.js"
import { getAllTaskStatuses } from "../../controllers/utils/taskStatus.controller.js"


const router = express.Router()


router.get("/", verifyToken, authorize(["Manager", "Agent", "SuperAdmin"]), getAllTaskStatuses)



export default router;
