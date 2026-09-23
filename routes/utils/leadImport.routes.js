import express from "express";
import { verifyToken, authorize } from "../../middleware/auth.middleware.js";
import { uploadLeadImportFile } from "../../middleware/upload.middleware.js";
import { importLeadsFromExcel } from "../../controllers/utils/leadImport.controller.js";

const router = express.Router();

router.post(
    "/",
    verifyToken,
    authorize(["SuperAdmin", "Manager"]),
    uploadLeadImportFile.single("file"),
    importLeadsFromExcel
);

export default router;
