const express = require('express');
const router = express.Router();
const Session = require('../models/Session');
const Attempt = require('../models/Attempt');
const Game = require('../models/Game');
const Module = require('../models/Module');
const User = require('../models/User');
const { authenticate } = require('../middleware/auth');
const { requireAdmin, requireAuth } = require('../middleware/admin');

// All admin routes require authentication
router.use(authenticate);
router.use(requireAdmin);

// ─── GET /api/admin/users ─────────────────────────────────
router.get('/users', async (req, res) => {
  try {
    const users = await User.find({}).select('-password_hash').sort({ created_at: -1 });
    const usersWithStats = await Promise.all(users.map(async (user) => {
      const userAttempts = await Attempt.find({ user_id: user._id });
      const sessionsCount = await Session.countDocuments({ user_id: user._id });
      const submitted = userAttempts.filter(a => a.submitted);
      const avg_risk = submitted.length > 0
        ? Math.round(submitted.reduce((s, a) => s + (a.risk_score || 0), 0) / submitted.length)
        : 0;
      return {
        _id: user._id,
        username: user.username,
        email: user.email,
        full_name: user.full_name,
        created_at: user.created_at,
        last_login: user.last_login,
        sessions_count: sessionsCount,
        attempts_count: userAttempts.length,
        completions_count: submitted.length,
        avg_risk_score: avg_risk
      };
    }));
    res.json({ ok: true, users: usersWithStats });
  } catch (error) {
    console.error('Users fetch error:', error);
    res.status(500).json({ ok: false, err: 'Failed to fetch users.' });
  }
});

// ─── DELETE /api/admin/user/:userId ─────────────────────
router.delete('/user/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ ok: false, err: 'User not found.' });
    }
    if (user.is_admin) {
      return res.status(403).json({ ok: false, err: 'Cannot delete admin users.' });
    }
    await User.deleteOne({ _id: userId });
    await Session.deleteMany({ user_id: userId });
    const attResult = await Attempt.deleteMany({ user_id: userId });
    const gameResult = await Game.deleteMany({ user_id: userId });
    res.json({
      ok: true,
      message: 'User deleted.',
      deleted: {
        attempts: attResult.deletedCount,
        games: gameResult.deletedCount
      }
    });
  } catch (error) {
    console.error('Delete user error:', error);
    res.status(500).json({ ok: false, err: 'Failed to delete user.' });
  }
});

// ─── GET /api/admin/user/:userId/attempts ────────────────────
// Get all attempts for a specific user with module details
router.get('/user/:userId/attempts', async (req, res) => {
  try {
    const { userId } = req.params;
    
    // Verify user exists
    const user = await User.findById(userId).select('-password_hash');
    if (!user) {
      return res.status(404).json({ ok: false, err: 'User not found.' });
    }
    
    // Get all attempts for this user
    const attempts = await Attempt.find({ user_id: userId })
      .sort({ completed_at: -1 });
    
    // Get all modules to enrich the data
    const modules = await Module.find();
    const moduleMap = {};
    modules.forEach(m => { moduleMap[m.module_id] = m; });
    
    // Group attempts by module
    const byModule = {};
    let totalRisk = 0;
    let totalQuiz = 0;
    let totalModulesCompleted = 0;
    let totalGamesPlayed = 0;
    
    attempts.forEach(att => {
      if (att.module_id < 0) {
        // Game attempt
        totalGamesPlayed++;
        return;
      }
      
      if (!byModule[att.module_id]) {
        const meta = moduleMap[att.module_id] || {};
        byModule[att.module_id] = {
          module_id: att.module_id,
          title: meta.title || `Module ${att.module_id}`,
          icon: meta.icon || '📦',
          tag: meta.tag || '—',
          difficulty: meta.diff || meta.difficulty || 'med',
          attempts: 0,
          submitted: 0,
          best_risk: 0,
          best_quiz_pct: 0,
          last_attempt: null
        };
      }
      
      const mod = byModule[att.module_id];
      mod.attempts++;
      
      if (att.submitted) {
        mod.submitted++;
        totalModulesCompleted++;
        if ((att.risk_score || 0) > mod.best_risk) mod.best_risk = att.risk_score;
        
        if (att.quiz_total > 0) {
          const pct = Math.round((att.quiz_score / att.quiz_total) * 100);
          if (pct > mod.best_quiz_pct) mod.best_quiz_pct = pct;
          totalQuiz += att.quiz_score;
        }
        
        totalRisk += (att.risk_score || 0);
      }
      
      if (!mod.last_attempt || new Date(att.completed_at) > new Date(mod.last_attempt)) {
        mod.last_attempt = att.completed_at;
      }
    });
    
    // Calculate averages
    const modulesArr = Object.values(byModule).map(m => ({
      ...m,
      avg_risk: m.submitted > 0 ? Math.round(m.best_risk) : 0,
      status: m.submitted > 0 ? 'completed' : 'in-progress',
      started: m.attempts > 0
    }));
    
    modulesArr.sort((a, b) => a.module_id - b.module_id);
    
    // Calculate overall stats
    const submittedAttempts = attempts.filter(a => a.submitted && a.module_id >= 0);
    const avg_risk = submittedAttempts.length > 0
      ? Math.round(submittedAttempts.reduce((s, a) => s + (a.risk_score || 0), 0) / submittedAttempts.length)
      : 0;
    const avg_quiz_pct = submittedAttempts.filter(a => a.quiz_total > 0).length > 0
      ? Math.round(
          submittedAttempts
            .filter(a => a.quiz_total > 0)
            .reduce((s, a) => s + ((a.quiz_score / a.quiz_total) * 100), 0) /
          submittedAttempts.filter(a => a.quiz_total > 0).length
        )
      : 0;
    
    res.json({
      ok: true,
      user: {
        _id: user._id,
        username: user.username,
        email: user.email,
        full_name: user.full_name,
        created_at: user.created_at,
        last_login: user.last_login
      },
      stats: {
        total_attempts: attempts.length,
        total_modules_completed: totalModulesCompleted,
        total_games_played: totalGamesPlayed,
        avg_risk,
        avg_quiz_pct,
        total_risk_points: totalRisk,
        total_quiz_points: totalQuiz
      },
      modules: modulesArr
    });
  } catch (error) {
    console.error('User attempts fetch error:', error);
    res.status(500).json({ ok: false, err: 'Failed to fetch user attempts.' });
  }
});

// ─── GET /api/admin/stats ─────────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    const total_sessions = await Session.countDocuments();
    const total_submissions = await Attempt.countDocuments({ submitted: true });
    const total_modules_completed = await Attempt.countDocuments({
      submitted: true,
      module_id: { $gte: 0 }
    });
    const total_games = await Game.countDocuments();
    const riskAgg = await Attempt.aggregate([
      { $match: { submitted: true } },
      { $group: { _id: null, avgRisk: { $avg: '$risk_score' } } }
    ]);
    const avg_risk_score = riskAgg.length > 0 ? Math.round(riskAgg[0].avgRisk) : 0;
    const totalRiskAgg = await Session.aggregate([
      { $group: { _id: null, total: { $sum: '$total_risk_score' } } }
    ]);
    const total_risk_points = totalRiskAgg.length > 0 ? totalRiskAgg[0].total : 0;
    res.json({
      ok: true,
      stats: {
        total_sessions,
        total_submissions,
        total_modules_completed,
        total_games,
        avg_risk_score,
        total_risk_points
      }
    });
  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({ ok: false, err: 'Failed to fetch stats.' });
  }
});

// ─── GET /api/admin/recent ────────────────────────────────
router.get('/recent', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const attempts = await Attempt.find({ module_id: { $gte: 0 } })
      .sort({ completed_at: -1 })
      .limit(limit);
    res.json({ ok: true, attempts });
  } catch (error) {
    res.status(500).json({ ok: false, err: 'Failed to fetch recent activity.' });
  }
});

// ─── GET /api/admin/sessions ──────────────────────────────
router.get('/sessions', async (req, res) => {
  try {
    const sessions = await Session.find()
      .sort({ started_at: -1 })
      .limit(100);
    const sessionsWithStats = await Promise.all(
      sessions.map(async (session) => {
        const attempts = await Attempt.find({ session_id: session.session_id });
        const games = await Game.find({ session_id: session.session_id });
        const completed_modules = attempts.filter(a => a.submitted && a.module_id >= 0).length;
        const total_risk = attempts.reduce((max, a) => Math.max(max, a.risk_score || 0), 0);
        const total_quiz = attempts.reduce((sum, a) => sum + (a.quiz_score || 0), 0);
        return {
          ...session.toObject(),
          completed_modules,
          total_risk_score: total_risk,
          quiz_score: total_quiz,
          games_played: games.length
        };
      })
    );
    res.json({ ok: true, sessions: sessionsWithStats });
  } catch (error) {
    console.error('Sessions fetch error:', error);
    res.status(500).json({ ok: false, err: 'Failed to fetch sessions.' });
  }
});

// ─── GET /api/admin/modules ───────────────────────────────
// Module-wise analytics (returns 'difficulty' to match frontend)
router.get('/modules', async (req, res) => {
  try {
    const modules = await Module.find().sort({ module_id: 1 });
    const moduleStats = await Promise.all(
      modules.map(async (mod) => {
        const attempts = await Attempt.find({ module_id: mod.module_id });
        const submitted = attempts.filter(a => a.submitted);
        const quizAttempts = submitted.filter(a => a.quiz_total > 0);
        const avg_risk = submitted.length > 0
          ? Math.round(submitted.reduce((s, a) => s + (a.risk_score || 0), 0) / submitted.length)
          : 0;
        const avg_quiz_pct = quizAttempts.length > 0
          ? Math.round(
            quizAttempts.reduce((s, a) => s + ((a.quiz_score / a.quiz_total) * 100), 0) / quizAttempts.length
          )
          : 0;
        return {
          module_id: mod.module_id,
          module_title: mod.title,
          module_tag: mod.tag,
          difficulty: mod.diff || mod.difficulty || 'med',
          icon: mod.icon,
          attempts: attempts.length,
          completions: submitted.length,
          avg_risk,
          avg_quiz_pct
        };
      })
    );
    res.json({ ok: true, byModule: moduleStats });
  } catch (error) {
    console.error('Module stats error:', error);
    res.status(500).json({ ok: false, err: 'Failed to fetch module stats.' });
  }
});

// ─── DELETE /api/admin/session/:sessionId ────────────────
router.delete('/session/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    await Session.deleteOne({ session_id: sessionId });
    const attemptResult = await Attempt.deleteMany({ session_id: sessionId });
    const gameResult = await Game.deleteMany({ session_id: sessionId });
    res.json({
      ok: true,
      message: 'Session deleted.',
      deleted: {
        attempts: attemptResult.deletedCount,
        games: gameResult.deletedCount
      }
    });
  } catch (error) {
    console.error('Delete session error:', error);
    res.status(500).json({ ok: false, err: 'Failed to delete session.' });
  }
});

// ─── DELETE /api/admin/module/:moduleId ──────────────────
router.delete('/module/:moduleId', async (req, res) => {
  try {
    const moduleId = parseInt(req.params.moduleId);
    const result = await Attempt.deleteMany({ module_id: moduleId });
    res.json({
      ok: true,
      message: `Deleted all attempts for module ${moduleId}.`,
      deleted: result.deletedCount
    });
  } catch (error) {
    res.status(500).json({ ok: false, err: 'Failed to delete module data.' });
  }
});

// ─── DELETE /api/admin/wipe ─────────────────────────────
router.delete('/wipe', async (req, res) => {
  try {
    const sessions = await Session.deleteMany({});
    const attempts = await Attempt.deleteMany({});
    const games = await Game.deleteMany({});
    res.json({
      ok: true,
      message: 'All data wiped successfully.',
      deleted: {
        sessions: sessions.deletedCount,
        attempts: attempts.deletedCount,
        games: games.deletedCount
      }
    });
  } catch (error) {
    console.error('Wipe error:', error);
    res.status(500).json({ ok: false, err: 'Failed to wipe data.' });
  }
});

// ─── GET /api/admin/export ──────────────────────────────
router.get('/export', requireAdmin, async (req, res) => {
  try {
    const sessions = await Session.find();
    const attempts = await Attempt.find();
    const games = await Game.find();
    const modules = await Module.find();
    const exportData = {
      exported_at: new Date().toISOString(),
      totals: {
        sessions: sessions.length,
        attempts: attempts.length,
        games: games.length,
        modules: modules.length
      },
      sessions,
      attempts,
      games,
      modules
    };
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="scamshield-export-${Date.now()}.json"`);
    res.json(exportData);
  } catch (error) {
    console.error('Export error:', error);
    res.status(500).json({ ok: false, err: 'Failed to export data.' });
  }
});

// ─── POST /api/admin/module ──────────────────────────────
router.post('/module', requireAdmin, async (req, res) => {
  try {
    const moduleData = req.body;
    if (moduleData.module_id === undefined || !moduleData.title) {
      return res.status(400).json({
        ok: false,
        err: 'module_id and title are required.'
      });
    }
    const module = await Module.findOneAndUpdate(
      { module_id: moduleData.module_id },
      moduleData,
      { new: true, upsert: true, runValidators: true }
    );
    res.json({
      ok: true,
      message: 'Module saved.',
      module
    });
  } catch (error) {
    console.error('Module save error:', error);
    res.status(500).json({ ok: false, err: 'Failed to save module.' });
  }
});

module.exports = router;