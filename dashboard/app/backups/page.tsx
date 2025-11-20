"use client";

import { useState, useEffect } from "react";
import { API_BASE_URL, getHeaders } from "../../lib/api";

function calculateDiskUsage(diskSpace: any) {
  if (!diskSpace || typeof diskSpace.available !== 'number' || typeof diskSpace.total !== 'number') {
    return null;
  }
  if (diskSpace.total === 0) return 0;
  return ((diskSpace.total - diskSpace.available) / diskSpace.total) * 100;
}

export default function BackupsPage() {
  const [status, setStatus] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");

  const fetchStatus = async () => {
    try {
      const res = await fetch(`${API_BASE_URL}/admin/backup/status`, {
        headers: getHeaders(),
      });
      if (res.ok) {
        const data = await res.json();
        setStatus(data);
      }
    } catch (e) {
      console.error(e);
    }
  };

  useEffect(() => {
    fetchStatus();
  }, []);

  const handleCreateBackup = async () => {
    setLoading(true);
    setMessage("");
    try {
      const res = await fetch(`${API_BASE_URL}/admin/backup/create`, {
        method: "POST",
        headers: getHeaders(),
      });
      const data = await res.json();
      if (data.success) {
        setMessage(`Backup created: ${data.filename}`);
        fetchStatus();
      } else {
        setMessage(`Error: ${data.error}`);
      }
    } catch (e) {
      setMessage("Failed to create backup");
    }
    setLoading(false);
  };

  const handleRestore = async (filename: string, source: string) => {
      if(!confirm("Restoring will overwrite the current database. Continue?")) return;
      setLoading(true);
      try {
          const res = await fetch(`${API_BASE_URL}/admin/backup/restore`, {
              method: "POST",
              headers: getHeaders(),
              body: JSON.stringify({ filename, source })
          });
          const data = await res.json();
          if (data.success) {
              setMessage("Restore completed successfully");
          } else {
              setMessage(`Restore failed: ${data.error}`);
          }
      } catch (e) {
          setMessage("Restore request failed");
      }
      setLoading(false);
  };

  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [scheduleFreq, setScheduleFreq] = useState("daily");
  const [retentionDays, setRetentionDays] = useState(7);

  useEffect(() => {
      if (status?.schedule) {
          setScheduleEnabled(status.schedule.enabled);
          setScheduleFreq(status.schedule.frequency);
          setRetentionDays(status.schedule.retention);
      }
  }, [status]);

  const handleSaveConfig = async () => {
      try {
          await fetch(`${API_BASE_URL}/admin/backup/config`, {
              method: "POST",
              headers: getHeaders(),
              body: JSON.stringify({
                  scheduleEnabled,
                  scheduleFreq,
                  retentionDays
              })
          });
          alert("Configuration saved");
      } catch(e) {
          alert("Failed to save config");
      }
  }

  const diskUsage = status?.diskSpace ? calculateDiskUsage(status.diskSpace) : null;

  return (
    <div className="p-8 max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold mb-6">Backups</h1>

      {message && <div className="mb-4 p-4 bg-blue-100 text-blue-800 rounded">{message}</div>}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
        <div className="p-6 bg-white rounded shadow">
          <h2 className="text-lg font-semibold mb-2">Storage Status</h2>
          <div className="text-3xl font-bold">
            {diskUsage !== null ? `${diskUsage.toFixed(1)}%` : <span className="text-gray-400">Unknown</span>}
          </div>
          <p className="text-gray-500 text-sm">Disk Usage</p>
          {diskUsage === null && (
              <p className="text-xs text-gray-400 mt-1">Disk space metrics not available on this platform</p>
          )}
        </div>

        <div className="p-6 bg-white rounded shadow flex items-center justify-center">
          <button
            onClick={handleCreateBackup}
            disabled={loading}
            className="px-6 py-3 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
          >
            {loading ? "Processing..." : "Create New Backup"}
          </button>
        </div>
      </div>

      <div className="mb-8 p-6 bg-white rounded shadow">
          <h2 className="text-lg font-semibold mb-4">Scheduling Policy</h2>
          <div className="space-y-4">
              <div className="flex items-center">
                  <label className="mr-2">Enable Schedule:</label>
                  <input
                    type="checkbox"
                    checked={scheduleEnabled}
                    onChange={e => setScheduleEnabled(e.target.checked)}
                  />
              </div>
              <div>
                  <label className="mr-2">Frequency:</label>
                  <select
                    value={scheduleFreq}
                    onChange={e => setScheduleFreq(e.target.value)}
                    className="border p-1"
                  >
                      <option value="daily">Daily</option>
                      <option value="weekly">Weekly</option>
                  </select>
              </div>
              <div>
                  <label className="mr-2">Retention (days):</label>
                  <input
                    type="number"
                    value={retentionDays}
                    onChange={e => setRetentionDays(Number(e.target.value))}
                    className="border p-1 w-20"
                  />
              </div>
              <button
                onClick={handleSaveConfig}
                className="px-4 py-2 bg-gray-800 text-white rounded hover:bg-gray-900"
              >
                  Save Policy
              </button>
          </div>
      </div>

      <div className="bg-white rounded shadow overflow-hidden">
        <h2 className="text-lg font-semibold p-6 border-b">Local Backups</h2>
        <table className="w-full text-left">
          <thead className="bg-gray-50">
            <tr>
              <th className="p-4">Filename</th>
              <th className="p-4">Size</th>
              <th className="p-4">Created</th>
              <th className="p-4">Actions</th>
            </tr>
          </thead>
          <tbody>
            {status?.backups?.map((b: any) => (
              <tr key={b.filename} className="border-b last:border-0">
                <td className="p-4">{b.filename}</td>
                <td className="p-4">{(b.size / 1024 / 1024).toFixed(2)} MB</td>
                <td className="p-4">{new Date(b.createdAt).toLocaleString()}</td>
                <td className="p-4 space-x-2">
                    <button
                        onClick={() => handleRestore(b.filename, "local")}
                        className="text-blue-600 hover:underline"
                    >
                        Restore
                    </button>
                </td>
              </tr>
            ))}
            {!status?.backups?.length && (
                <tr><td colSpan={4} className="p-4 text-center text-gray-500">No backups found</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
