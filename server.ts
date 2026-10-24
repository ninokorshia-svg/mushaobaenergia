import express from 'express';
import type { Request, Response } from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { DEFAULT_QUIZ } from './src/data/defaultQuiz.ts';
import type { QuizConfig, StudentSubmission, FormativeAssessment } from './src/types/quiz.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isProd = process.env.NODE_ENV === 'production';
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

interface TeacherRecord {
  teacherCode: string;
  sessionId: string;
  claimedAt: number;
  lastHeartbeat: number;
  customQuiz?: QuizConfig;
  submissions: StudentSubmission[];
}

// In-memory store
const teachersMap = new Map<string, TeacherRecord>();

// Prepopulate Teachers1 to Teachers100
for (let i = 1; i <= 100; i++) {
  const code = `Teachers${i}`;
  teachersMap.set(code, {
    teacherCode: code,
    sessionId: '',
    claimedAt: 0,
    lastHeartbeat: 0,
    customQuiz: DEFAULT_QUIZ,
    submissions: []
  });
}

function calculateGradeAndAssessment(points: number, maxPoints: number = 30): {
  gradeOutOf10: number;
  percentage: number;
  formativeAssessment: FormativeAssessment;
} {
  const percentage = Math.round((points / maxPoints) * 100);
  let gradeOutOf10 = Math.round((points / maxPoints) * 10);
  if (gradeOutOf10 < 1) gradeOutOf10 = 1;

  let formativeAssessment: FormativeAssessment = 'საჭიროებს მხარდაჭერას';
  if (percentage >= 85) {
    formativeAssessment = 'გაფართოებული/შემოქმედებითი';
  } else if (percentage >= 60) {
    formativeAssessment = 'დამოუკიდებელი';
  } else {
    formativeAssessment = 'საჭიროებს მხარდაჭერას';
  }

  return { gradeOutOf10, percentage, formativeAssessment };
}

async function startServer() {
  const app = express();
  app.use(express.json());

  // Health check
  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Get active teacher codes status (for colleague sharing and code availability)
  app.get('/api/teachers/status', (_req: Request, res: Response) => {
    const now = Date.now();
    const statusList: { code: string; isOccupied: boolean; submissionsCount: number }[] = [];

    teachersMap.forEach((rec, code) => {
      // Considered occupied if heartbeat within 2 minutes and has a sessionId
      const isOccupied = Boolean(rec.sessionId && (now - rec.lastHeartbeat < 120000));
      statusList.push({
        code,
        isOccupied,
        submissionsCount: rec.submissions.length
      });
    });

    res.json({ teachers: statusList });
  });

  // Claim teacher code
  app.post('/api/teacher/claim', (req: Request, res: Response) => {
    const { teacherCode, sessionId } = req.body;
    if (!teacherCode || !sessionId) {
      res.status(400).json({ error: 'მასწავლებლის კოდი და სესიის იდენტიფიკატორი სავალდებულოა' });
      return;
    }

    const normalizedCode = teacherCode.trim();
    const match = normalizedCode.match(/^Teachers([1-9][0-9]?|100)$/i);
    if (!match) {
      res.status(400).json({ error: 'კოდი უნდა იყოს Teachers1-დან Teachers100-მდე ფორმატში!' });
      return;
    }

    const properCode = `Teachers${match[1]}`;
    let rec = teachersMap.get(properCode);
    if (!rec) {
      rec = {
        teacherCode: properCode,
        sessionId: '',
        claimedAt: 0,
        lastHeartbeat: 0,
        customQuiz: DEFAULT_QUIZ,
        submissions: []
      };
      teachersMap.set(properCode, rec);
    }

    const now = Date.now();
    const isOccupied = Boolean(rec.sessionId && rec.sessionId !== sessionId && (now - rec.lastHeartbeat < 120000));

    if (isOccupied) {
      res.status(409).json({
        error: 'ეს კოდი უკვე დაკავებულია!',
        teacherCode: properCode,
        isOccupied: true
      });
      return;
    }

    // Assign session
    rec.sessionId = sessionId;
    rec.claimedAt = now;
    rec.lastHeartbeat = now;

    res.json({
      success: true,
      teacherCode: properCode,
      quiz: rec.customQuiz || DEFAULT_QUIZ,
      submissionsCount: rec.submissions.length
    });
  });

  // Teacher heartbeat
  app.post('/api/teacher/heartbeat', (req: Request, res: Response) => {
    const { teacherCode, sessionId } = req.body;
    const rec = teachersMap.get(teacherCode);
    if (rec && rec.sessionId === sessionId) {
      rec.lastHeartbeat = Date.now();
      res.json({ success: true });
      return;
    }
    res.json({ success: false });
  });

  // Teacher release code (logout)
  app.post('/api/teacher/release', (req: Request, res: Response) => {
    const { teacherCode, sessionId } = req.body;
    const rec = teachersMap.get(teacherCode);
    if (rec && (rec.sessionId === sessionId || !sessionId)) {
      rec.sessionId = '';
      rec.lastHeartbeat = 0;
      res.json({ success: true, message: 'კოდი წარმატებით გათავისუფლდა' });
      return;
    }
    res.json({ success: true });
  });

  // Update quiz (topic, questions, image URLs)
  app.post('/api/teacher/update-quiz', (req: Request, res: Response) => {
    const { teacherCode, quizConfig } = req.body;
    if (!teacherCode || !quizConfig) {
      res.status(400).json({ error: 'მონაცემები არასრულია' });
      return;
    }

    const rec = teachersMap.get(teacherCode);
    if (!rec) {
      res.status(404).json({ error: 'მასწავლებლის კოდი ვერ მოიძებნა' });
      return;
    }

    rec.customQuiz = quizConfig;
    res.json({ success: true, message: 'ქვიზი წარმატებით განახლდა', quiz: rec.customQuiz });
  });

  // Reset quiz to default
  app.post('/api/teacher/reset-quiz', (req: Request, res: Response) => {
    const { teacherCode } = req.body;
    const rec = teachersMap.get(teacherCode);
    if (rec) {
      rec.customQuiz = DEFAULT_QUIZ;
      res.json({ success: true, quiz: DEFAULT_QUIZ });
      return;
    }
    res.status(404).json({ error: 'მასწავლებელი ვერ მოიძებნა' });
  });

  // Get quiz and session details for student or teacher
  app.get('/api/session/:teacherCode', (req: Request, res: Response) => {
    const code = req.params.teacherCode;
    const rec = teachersMap.get(code);
    if (!rec) {
      res.status(404).json({ error: 'კოდი ვერ მოიძებნა' });
      return;
    }
    res.json({
      teacherCode: rec.teacherCode,
      quiz: rec.customQuiz || DEFAULT_QUIZ,
      active: Boolean(rec.sessionId && (Date.now() - rec.lastHeartbeat < 180000)),
      totalSubmissions: rec.submissions.length
    });
  });

  // Check if student is already submitted on this device or with this name/number
  app.post('/api/student/check-status', (req: Request, res: Response) => {
    const { teacherCode, deviceId, studentNameOrNumber } = req.body;
    const rec = teachersMap.get(teacherCode);
    if (!rec) {
      res.status(404).json({ error: 'მასწავლებლის კოდი ვერ მოიძებნა' });
      return;
    }

    const cleanInput = (studentNameOrNumber || '').trim().toLowerCase();
    const existing = rec.submissions.find(s => 
      (deviceId && s.deviceId === deviceId) ||
      (cleanInput && s.studentNameOrNumber.trim().toLowerCase() === cleanInput)
    );

    if (existing) {
      res.json({
        isBlocked: true,
        submission: existing,
        message: 'ტესტის ერთხელ შევსებისა და გაგზავნის შემდეგ, იმავე მოწყობილობიდან ან იმავე სახელით/ნომრით მეორედ შესვლა დაბლოკილია.'
      });
      return;
    }

    res.json({ isBlocked: false });
  });

  // Student submission
  app.post('/api/student/submit', (req: Request, res: Response) => {
    const {
      teacherCode,
      studentNameOrNumber,
      authType,
      deviceId,
      answers,
      durationSeconds
    } = req.body;

    if (!teacherCode || !studentNameOrNumber || !answers) {
      res.status(400).json({ error: 'გაგზავნილი მონაცემები არასრულია' });
      return;
    }

    const rec = teachersMap.get(teacherCode);
    if (!rec) {
      res.status(404).json({ error: 'მასწავლებლის კოდი ვერ მოიძებნა' });
      return;
    }

    // Check duplicate
    const cleanInput = studentNameOrNumber.trim().toLowerCase();
    const alreadySubmitted = rec.submissions.find(s => 
      (deviceId && s.deviceId === deviceId) ||
      (cleanInput && s.studentNameOrNumber.trim().toLowerCase() === cleanInput)
    );

    if (alreadySubmitted) {
      res.status(403).json({
        error: 'ტესტი უკვე შევსებულია! განმეორებითი შევსება შეზღუდულია.',
        submission: alreadySubmitted
      });
      return;
    }

    // Calculate score
    const currentQuiz = rec.customQuiz || DEFAULT_QUIZ;
    let totalPoints = 0;
    const maxPoints = currentQuiz.questions.reduce((sum, q) => sum + (q.points || 1), 0);

    const verifiedAnswers = currentQuiz.questions.map(q => {
      const studentAns = (answers as Array<{ questionId: number; selectedOptionId: string }>).find(a => a.questionId === q.id);
      const selectedOptionId = studentAns ? studentAns.selectedOptionId : '';
      const isCorrect = selectedOptionId === q.correctOptionId;
      const earned = isCorrect ? (q.points || 1) : 0;
      totalPoints += earned;

      return {
        questionId: q.id,
        selectedOptionId,
        isCorrect,
        earnedPoints: earned
      };
    });

    const { gradeOutOf10, percentage, formativeAssessment } = calculateGradeAndAssessment(totalPoints, maxPoints);

    const newSubmission: StudentSubmission = {
      id: `sub_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      teacherCode,
      studentNameOrNumber: studentNameOrNumber.trim(),
      authType: authType || 'name',
      deviceId: deviceId || 'unknown',
      submittedAt: new Date().toISOString(),
      totalPoints,
      maxPoints,
      percentage,
      gradeOutOf10,
      formativeAssessment,
      answers: verifiedAnswers,
      durationSeconds: durationSeconds || 0
    };

    rec.submissions.unshift(newSubmission);

    res.json({
      success: true,
      submission: newSubmission
    });
  });

  // Get submissions for teacher (Real-time polling)
  app.get('/api/teacher/submissions/:teacherCode', (req: Request, res: Response) => {
    const code = req.params.teacherCode;
    const rec = teachersMap.get(code);
    if (!rec) {
      res.status(404).json({ error: 'მასწავლებლის კოდი ვერ მოიძებნა' });
      return;
    }

    res.json({
      teacherCode: rec.teacherCode,
      submissions: rec.submissions,
      lastUpdated: new Date().toISOString()
    });
  });

  // Clear submissions ("სიის გასუფთავება")
  app.post('/api/teacher/clear-submissions', (req: Request, res: Response) => {
    const { teacherCode } = req.body;
    const rec = teachersMap.get(teacherCode);
    if (!rec) {
      res.status(404).json({ error: 'მასწავლებლის კოდი ვერ მოიძებნა' });
      return;
    }

    rec.submissions = [];
    res.json({ success: true, message: 'სია წარმატებით გასუფთავდა' });
  });

  // Vite integration
  if (!isProd) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    if (fs.existsSync(distPath)) {
      app.use(express.static(distPath));
      app.get('*', (_req: Request, res: Response) => {
        res.sendFile(path.resolve(distPath, 'index.html'));
      });
    }
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Quiz Server is running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
