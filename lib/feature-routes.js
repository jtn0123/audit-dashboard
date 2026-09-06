'use strict';

function mountFeatureRoutes(app, collector, requireGitHub) {
  app.get('/api/gh/advisories', requireGitHub, (req, res) => {
    res.json(collector.getAdvisories({ severity: req.query.severity, minRepos: req.query.minRepos }));
  });
  app.get('/api/gh/packages', requireGitHub, (req, res) => {
    res.json(collector.searchPackages(req.query.q));
  });
  app.get('/api/gh/snapshots', requireGitHub, (req, res) => res.json(collector.getSnapshots()));
  app.get('/api/gh/changes', requireGitHub, (req, res) => {
    if (typeof req.query.since !== 'string' || !Number.isFinite(Date.parse(req.query.since))) {
      return res.status(400).json({ error: 'A valid since timestamp is required' });
    }
    res.json({ changes: collector.getChangesSince(req.query.since) });
  });

}

module.exports = { mountFeatureRoutes };
