'use strict';

/**
 * Markdown morning briefing, built purely from collector read models — the
 * same numbers the dashboard shows, shaped for a Slack paste, an email, or an
 * agent's opening context. No network, no fs.
 */

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function severityLine(counts = {}) {
  const parts = [];
  for (const sev of ['critical', 'high', 'medium', 'low']) {
    if (counts[sev]) parts.push(`${counts[sev]} ${sev}`);
  }
  return parts.length ? parts.join(' · ') : 'none';
}

/**
 * `input`: { status, summary, actions, generatedAt } — collector.getStatus(),
 * collector.state.summary, collector.getActions(). Any piece may be missing;
 * the digest degrades to what it can say.
 */
function buildDigest({ status, summary, actions, generatedAt = new Date().toISOString() } = {}) {
  const lines = [`# Patch Board digest — ${generatedAt.slice(0, 10)}`, ''];

  if (!status?.configured) {
    lines.push('GitHub integration is **not configured** — set `GITHUB_TOKEN` to activate the patch board.', '');
    return lines.join('\n');
  }

  const fresh = actions ?? {};
  lines.push(`_Data as of ${fresh.dataAsOf || status.fetchedAt || 'never'}${fresh.stale ? ' — **stale**, refresh before acting' : ''}_`, '');

  if (summary) {
    const cov = summary.coverage || {};
    lines.push('## Posture');
    lines.push(`- **${plural(summary.activeCount ?? 0, 'active repo')}**, ${cov.covered ?? 0} covered by Dependabot (${cov.percent ?? 0}%)`);
    lines.push(`- **Open alerts:** ${severityLine(summary.alerts)}`);
    lines.push(`- **Open PRs:** ${summary.prs?.dependabot ?? 0} Dependabot · ${summary.prs?.other ?? 0} human · ${summary.prs?.stale ?? 0} stale`);
    if (cov.noConfig?.length) lines.push(`- **No dependabot.yml:** ${cov.noConfig.join(', ')}`);
    if (cov.alertsOff?.length) lines.push(`- **Alerts disabled:** ${cov.alertsOff.join(', ')}`);
    if (cov.neverScanned?.length) lines.push(`- **Never scanned:** ${cov.neverScanned.join(', ')}`);
    lines.push('');
  }

  const queue = fresh.actions || [];
  const byType = {};
  for (const a of queue) (byType[a.type] ||= []).push(a);

  lines.push('## Work queue');
  if (!queue.length) {
    lines.push('Nothing actionable — the board is clean.', '');
  } else {
    const mergeable = byType.merge_pr || [];
    if (mergeable.length) {
      lines.push(`**${plural(mergeable.length, 'PR')} safe to merge:**`);
      for (const a of mergeable.slice(0, 10)) lines.push(`- ${a.repo} [#${a.pr}](${a.url || '#'}) — ${a.title || a.why}`);
      if (mergeable.length > 10) lines.push(`- …and ${mergeable.length - 10} more`);
      lines.push('');
    }
    const gaps = [...(byType.enable_alerts || []), ...(byType.enable_security_updates || []), ...(byType.add_dependabot_config || [])];
    if (gaps.length) {
      lines.push(`**${plural(gaps.length, 'coverage gap')}:**`);
      for (const a of gaps.slice(0, 10)) lines.push(`- ${a.repo} — ${a.why}`);
      lines.push('');
    }
    const flagged = byType.flag_pr || [];
    if (flagged.length) {
      lines.push(`**${plural(flagged.length, 'PR')} need eyes:**`);
      for (const a of flagged.slice(0, 10)) lines.push(`- ${a.repo} #${a.pr} — ${a.why}`);
      lines.push('');
    }
    const closes = byType.close_superseded || [];
    if (closes.length) {
      lines.push(`**${plural(closes.length, 'superseded PR')} to close:**`);
      for (const a of closes) lines.push(`- ${a.repo} #${a.pr} — ${a.why}`);
      lines.push('');
    }
  }

  if (status.rate) lines.push(`_${status.rate.remaining}/${status.rate.limit} GitHub API calls remaining this hour._`);
  return lines.join('\n');
}

module.exports = { buildDigest };
