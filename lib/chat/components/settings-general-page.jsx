'use client';

import { useState, useEffect } from 'react';
import { getGeneralSettings, updateGeneralSetting } from '../actions.js';

export function SettingsGeneralPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [includeBeta, setIncludeBeta] = useState(false);

  useEffect(() => {
    getGeneralSettings().then((result) => {
      if (result.settings) {
        setIncludeBeta(result.settings.UPGRADE_INCLUDE_BETA === 'true');
      }
      setLoading(false);
    });
  }, []);

  const [showBetaConfirm, setShowBetaConfirm] = useState(false);

  const handleToggle = async () => {
    if (!includeBeta) {
      setShowBetaConfirm(true);
      return;
    }
    setIncludeBeta(false);
    setSaving(true);
    await updateGeneralSetting('UPGRADE_INCLUDE_BETA', 'false');
    setSaving(false);
  };

  const confirmBeta = async () => {
    setShowBetaConfirm(false);
    setIncludeBeta(true);
    setSaving(true);
    await updateGeneralSetting('UPGRADE_INCLUDE_BETA', 'true');
    setSaving(false);
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="h-6 w-48 bg-muted animate-pulse rounded" />
        <div className="rounded-lg border bg-card p-4">
          <div className="h-4 w-64 bg-muted animate-pulse rounded mb-3" />
          <div className="h-4 w-96 bg-muted animate-pulse rounded" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Auto Upgrade */}
      <div>
        <h2 className="text-lg font-medium mb-1">Auto Upgrade</h2>
        <p className="text-sm text-muted-foreground mb-4">
          Configure how the system checks for new versions.
        </p>

        <div className="rounded-lg border bg-card p-4">
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={includeBeta}
              onChange={handleToggle}
              disabled={saving}
              className="mt-1 h-4 w-4 rounded border-border accent-foreground"
            />
            <div>
              <span className="text-sm font-medium">Include beta versions</span>
              <p className="text-sm text-muted-foreground mt-0.5">
                Stable installs only check for stable releases by default. Enable this to also check the beta channel for pre-release updates.
              </p>
            </div>
          </label>
        </div>

        {showBetaConfirm && (
          <div className="mt-3 rounded-lg border border-yellow-500/50 bg-yellow-500/10 p-4">
            <p className="text-sm font-medium text-yellow-500 mb-1">
              Are you sure?
            </p>
            <p className="text-sm text-muted-foreground mb-3">
              Beta releases may contain breaking changes that could require manual recovery, including SSH access to your server, restoring backups, or re-running setup. Only enable this if you're comfortable troubleshooting issues.
            </p>
            <div className="flex gap-2">
              <button
                onClick={confirmBeta}
                disabled={saving}
                className="px-3 py-1.5 text-sm font-medium rounded-md bg-yellow-500/20 text-yellow-500 hover:bg-yellow-500/30 transition-colors"
              >
                {saving ? 'Saving...' : 'Enable beta releases'}
              </button>
              <button
                onClick={() => setShowBetaConfirm(false)}
                disabled={saving}
                className="px-3 py-1.5 text-sm font-medium rounded-md text-muted-foreground hover:bg-muted transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
