// const express = require('express');
// const router = express.Router();

// router.get('/test', (req, res) => {
//   res.json({ ok: true, message: 'Admin route working' });
// });

// module.exports = router;

const express = require('express');
const Session = require('../models/Session');
const Attempt = require('../models/Attempt');
const Game = require('../models/Game');
const Module = require('../models/Module');
const User = require('../models/User');
const { authenticate } = require('../middleware/auth');
const { requireAdmin, requireAuth } = require('../middleware/admin');

const router = express.Router();

// All admin routes require authentication
router.use(authenticate);
router.use(requireAdmin);

// ─── GET /api/admin/users ───────────────────────────────
router.get('/users', async (req, res) => {
  try {
    const User = require('../models/User');
    const Attempt = require('../models/Attempt');
    const Session = require('../models/Session');
    
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
    const User = require('../models/User');
    const Attempt = require('../models/Attempt');
    const Session = require('../models/Session');
    const Game = require('../models/Game');
    
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ ok: false, err: 'User not found.' });
    }
    
    // Don't allow deleting admins
    if (user.is_admin) {
      return res.status(403).json({ ok: false, err: 'Cannot delete admin users.' });
    }
    
    // Delete user
    await User.deleteOne({ _id: userId });
    
    // Delete user's sessions
    await Session.deleteMany({ user_id: userId });
    
    // Delete user's attempts
    const attResult = await Attempt.deleteMany({ user_id: userId });
    
    // Delete user's games
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

// ─── GET /api/admin/stats ──────────────────────────────────────────────────
// Dashboard statistics
router.get('/stats', async (req, res) => {
  try {
    const total_sessions = await Session.countDocuments();
    const total_submissions = await Attempt.countDocuments({ submitted: true });
    const total_modules_completed = await Attempt.countDocuments({
      submitted: true,
      module_id: { $gte: 0 }
    });
    const total_games = await Game.countDocuments();

    // Average risk score
    const riskAgg = await Attempt.aggregate([
      { $match: { submitted: true } },
      { $group: { _id: null, avgRisk: { $avg: '$risk_score' } } }
    ]);
    const avg_risk_score = riskAgg.length > 0 ? Math.round(riskAgg[0].avgRisk) : 0;

    // Total risk score across all sessions
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

// ─── GET /api/admin/recent ─────────────────────────────────────────────────
// Recent activity (last 50 attempts)
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

// ─── GET /api/admin/sessions ───────────────────────────────────────────────
// All sessions with aggregated stats
router.get('/sessions', async (req, res) => {
  try {
    const sessions = await Session.find()
      .sort({ started_at: -1 })
      .limit(100);

    // For each session, get aggregated data
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

// ─── GET /api/admin/byModule ─────────────────────────────────────────────────
// Get statistics grouped by module
router.get('/byModule', authAdmin, async (req, res) => {
  try {
    const byModule = await Attempt.aggregate([
      {
        $group: {
          _id: '$module_id',
          attempts: { $sum: 1 },
          completions: {
            $sum: { $cond: [{ $eq: ['$submitted', true] }, 1, 0] }
          },
          risk_sum: {
            $sum: { $cond: [{ $eq: ['$submitted', true] }, '$risk_score', 0] }
          },
          quiz_sum: {
            $sum: {
              $cond: [
                { $gt: ['$quiz_total', 0] },
                { $multiply: [{ $divide: ['$quiz_score', '$quiz_total'] }, 100] },
                0
              ]
            }
          },
          quiz_count: {
            $sum: { $cond: [{ $gt: ['$quiz_total', 0] }, 1, 0] }
          }
        }
      },
      {
        $project: {
          _id: 0,
          module_id: '$_id',
          attempts: 1,
          completions: 1,
          avg_risk: {
            $cond: [
              { $gt: ['$completions', 0] },
              { $round: [{ $divide: ['$risk_sum', '$completions'] }, 0] },
              0
            ]
          },
          avg_quiz_pct: {
            $cond: [
              { $gt: ['$quiz_count', 0] },
              { $round: [{ $divide: ['$quiz_sum', '$quiz_count'] }, 0] },
              0
            ]
          }
        }
      },
      { $sort: { module_id: 1 } }
    ]);

    // Enrich with module metadata (title, tag, difficulty)
    const Module = require('../models/Module');
    const modules = await Module.find({});
    const moduleMap = {};
    modules.forEach(m => { moduleMap[m.module_id] = m; });

    const enriched = byModule.map(stat => {
      const meta = moduleMap[stat.module_id] || {};
      return {
        ...stat,
        module_title: meta.title || `Module ${stat.module_id}`,
        module_tag: meta.tag || '—',
        difficulty: meta.difficulty || 'med'
      };
    });

    res.json({ ok: true, byModule: enriched });
  } catch (err) {
    console.error('byModule error:', err);
    res.status(500).json({ ok: false, err: 'Failed to fetch module stats.' });
  }
});

// ─── GET /api/admin/modules ────────────────────────────────────────────────
// Module-wise analytics
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
          title: mod.title,
          icon: mod.icon,
          tag: mod.tag,
          difficulty: mod.diff,
          active: mod.active,
          attempts: attempts.length,
          completions: submitted.length,
          avg_risk,
          avg_quiz_pct
        };
      })
    );

    res.json({ ok: true, modules: moduleStats });

  } catch (error) {
    console.error('Module stats error:', error);
    res.status(500).json({ ok: false, err: 'Failed to fetch module stats.' });
  }
});

// ─── DELETE /api/admin/session/:sessionId ──────────────────────────────────
// Delete a specific session and its attempts
router.delete('/session/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;

    // Delete session
    await Session.deleteOne({ session_id: sessionId });

    // Delete all attempts for this session
    const attemptResult = await Attempt.deleteMany({ session_id: sessionId });

    // Delete all games for this session
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

// ─── DELETE /api/admin/module/:moduleId ────────────────────────────────────
// Delete all attempts for a specific module
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

// ─── DELETE /api/admin/wipe ────────────────────────────────────────────────
// Wipe ALL data (sessions, attempts, games)
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

// ─── GET /api/admin/export ─────────────────────────────────────────────────
// Export all data as JSON
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

// ─── POST /api/admin/module ────────────────────────────────────────────────
// Create or update a module (for admin to add new scams)
router.post('/module', requireAdmin, async (req, res) => {
  try {
    const moduleData = req.body;

    if (moduleData.module_id === undefined || !moduleData.title) {
      return res.status(400).json({
        ok: false,
        err: 'module_id and title are required.'
      });
    }

    // Upsert (create or update)
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
router.get('/users', requireAdmin, async (req, res) => {
  try {
    const users = await User.find({})
      .select('-password_hash')
      .sort({ created_at: -1 });

    // Get stats per user
    const usersWithStats = await Promise.all(
      users.map(async (user) => {
        const userAttempts = await Attempt.find({ user_id: user._id });
        const sessions = await Session.countDocuments({ user_id: user._id });
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
          sessions_count: sessions,
          attempts_count: userAttempts.length,
          completions_count: submitted.length,
          avg_risk_score: avg_risk
        };
      })
    );

    res.json({ ok: true, users: usersWithStats });
  } catch (error) {
    console.error('Users fetch error:', error);
    res.status(500).json({ ok: false, err: 'Failed to fetch users.' });
  }
});

// ─── NEW: DELETE /api/admin/user/:id ─────────────────────────
// Delete a user and all their data
router.delete('/user/:userId', requireAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    
    // Delete user
    await User.deleteOne({ _id: userId });
    
    // Delete user's sessions
    await Session.deleteMany({ user_id: userId });
    
    // Delete user's attempts
    const attResult = await Attempt.deleteMany({ user_id: userId });
    
    // Delete user's games
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

module.exports = router;