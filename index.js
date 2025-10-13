import express from "express";
import axios from "axios";
import multer from "multer";
import "dotenv/config";
import cors from "cors";
import ResumeParser from "simple-resume-parser";
import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { GoogleGenAI } from "@google/genai";

const app = express();
const PORT = process.env.PORT || 3001;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(cors());
app.use(express.json());

const tempDir = path.join(__dirname, "temp");

// Ensure temp directory exists
(async () => {
  await fs.mkdir(tempDir, { recursive: true });
})();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (
      [
        "application/pdf",
        "application/msword",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ].includes(file.mimetype)
    ) {
      cb(null, true);
    } else {
      cb(new Error("Only PDF, DOC, DOCX allowed"), false);
    }
  },
});

// Initialize Gemini
const genAi = new GoogleGenAI({
  apiKey: process.env.GOOGLE_AI_STUDIO_KEY,
});

app.post("/api/upload-cv", upload.single("cv"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ msg: "Upload File to continue" });
  }

  const location = req.body.location;
  if (!location) {
    return res.status(400).json({ error: "Location is required" });
  }

  try {
    // Write buffer to temporal file
    const tempFilePath = path.join(
      tempDir,
      `temp-${Date.now()}-${req.file.originalname}`
    );
    await fs.writeFile(tempFilePath, req.file.buffer);

    // Parse the temporal file
    const resume = new ResumeParser(tempFilePath);
    const parsedFile = await resume.parseToJSON();

    // Delete temp file
    await fs.unlink(tempFilePath);

    // Prompting the AI and getting the result
    //const fullText = `${parsedFile.parts.experience || ""} ${
    //parsedFile.parts.skills || ""
    //}`.trim();
    const prompt = `You are an expert career analyst. Based on the full CV provided in JSON format, identify the **most accurate and specific job title** that best summarizes the candidate’s overall experience, skills, and roles. Prioritize titles that reflect technical expertise and hands-on work (e.g., "Full-Stack Web Developer", "AI Automation Engineer", "Software Technician", "Associate Professor", "Sales Representative", "Construction Worker"). Return ONLY the job title — no extra text, no punctuation. Text: "${parsedFile}"`;
    const result = await genAi.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt,
    });
    const rawKeywords = result.text.trim();
    console.log(rawKeywords);

    const keywords = rawKeywords
      .split(",")
      .map((keyword) => keyword.trim().replace(/\s+/g, "+"))
      .slice(0, 5);
    console.log("Extracted Words:", keywords);

    // Fetch Jobs
    let jobs = [];

    if (keywords.length > 0) {
      const searchKeywords = keywords.join(" ");
      console.log(searchKeywords);

      const adzunaResponse = await axios.get(
        "https://api.adzuna.com/v1/api/jobs/us/search/1",
        {
          params: {
            app_id: process.env.ADZUNA_APP_ID,
            app_key: process.env.ADZUNA_APP_KEY,
            what: searchKeywords,
            where: location,
            results_per_page: 10,
            sort_by: "relevance",
          },
        }
      );
      jobs = adzunaResponse.data.results || [];
      console.log(`Found ${jobs.length} jobs for ${location}`);
      console.log("Keywords Used:", searchKeywords);
    }

    console.log("Parsed CV:", parsedFile);
    console.log(process.env.GOOGLE_AI_STUDIO_KEY);
    res.json({
      success: true,
      // parsed: parsedFile,
      //keywords: keywords,
      jobs: jobs.map((job) => ({
        title: job.title,
        company: job.company.display_name,
        location: job.location.display_name,
        salary: job.salary_text || "Not specified",
        description: job.description.slice(0, 200) + "...",
        url: job.redirect_url,
      })),
    });
  } catch (error) {
    console.error("Error:", error);
    console.log(process.env.GOOGLE_AI_STUDIO_KEY);

    res.status(500).json({
      error: error.message,
    });
  }
});

app.listen(PORT, () => {
  console.log(`Listening On Port ${PORT}`);
});
