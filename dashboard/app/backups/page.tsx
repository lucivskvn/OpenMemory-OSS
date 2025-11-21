'use client';

import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Progress } from '@/components/ui/progress';
import { StatCard } from '@/components/dashboard/StatCard';
import { API_BASE_URL, getHeaders } from '@/lib/api';
import {
  Database,
  HardDrive,
  Upload,
  Download,
  Clock,
  AlertTriangle,
  CheckCircle,
  Trash2,
  RefreshCw,
} from 'lucide-react';
import { toast, Toaster } from 'sonner';

interface BackupStatus {
  lastBackup: string | null;
  backupCount: number;
  databaseSize: number;
  walSize: number;
  diskSpace: {
    available: number;
    total: number;
  } | null;
  cloudEnabled: boolean;
  autoSchedule: boolean;
  scheduleCron: string;
  retentionDays: number;
}

interface BackupMetadata {
  filename: string;
  size: number;
  createdAt: string;
  location: 'local' | 'cloud';
}

interface BackupResponse {
  success: boolean;
  filename: string;
  path: string;
  location: 'local' | 'cloud';
  timestamp: string;
}

export default function BackupsPage() {
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [backups, setBackups] = useState<BackupMetadata[]>([]);
  const [loading, setLoading] = useState(true);
  const [backupInProgress, setBackupInProgress] = useState(false);
  const [restoreInProgress, setRestoreInProgress] = useState(false);
  const [backupProgress, setBackupProgress] = useState(0);
  const [progressMessage, setProgressMessage] = useState('');
  const [integrityStatus, setIntegrityStatus] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);
  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [scheduleFreq, setScheduleFreq] = useState('daily');
  const [retentionDays, setRetentionDays] = useState(7);

  useEffect(() => {
    fetchBackupStatus();
    fetchBackups();
  }, []);

  // Initialize schedule state when status loads
  useEffect(() => {
    if (status) {
      setScheduleEnabled(status.autoSchedule);
      // Map cron to frequency option
      const cronFreqMap: { [key: string]: string } = {
        '0 * * * *': 'hourly',
        '0 2 * * *': 'daily',
        '0 2 * * 1': 'weekly',
      };
      setScheduleFreq(cronFreqMap[status.scheduleCron] || 'daily');
      setRetentionDays(status.retentionDays);
    }
  }, [status]);

  // Auto-hide integrity status after 10 seconds
  useEffect(() => {
    if (integrityStatus) {
      const timer = setTimeout(() => setIntegrityStatus(null), 10000);
      return () => clearTimeout(timer);
    }
  }, [integrityStatus]);

  const fetchBackupStatus = async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/admin/backup/status`, {
        headers: getHeaders(),
      });
      if (response.ok) {
        const data = await response.json();
        setStatus(data);
      }
    } catch (error) {
      console.error('Failed to fetch backup status:', error);
    }
  };

  const fetchBackups = async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/admin/backup/list`, {
        headers: getHeaders(),
      });
      if (response.ok) {
        const data = await response.json();
        setBackups(data.backups || []);
      }
    } catch (error) {
      console.error('Failed to fetch backups:', error);
    } finally {
      setLoading(false);
    }
  };

  const formatBytes = (bytes: number) => {
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    if (bytes === 0) return '0 Bytes';
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return Math.round((bytes / Math.pow(1024, i)) * 100) / 100 + ' ' + sizes[i];
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleString();
  };

  const handleBackup = async (cloud = false) => {
    setBackupInProgress(true);
    setBackupProgress(0);
    setProgressMessage('');

    try {
      const response = await fetch(`${API_BASE_URL}/admin/backup`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({ cloud }),
      });

      if (!response.ok) {
        throw new Error('Backup failed to start');
      }

      const result = await response.json();
      const sessionId = result.sessionId;

      if (!sessionId) {
        throw new Error('No session ID returned for progress tracking');
      }

      // Use polling for progress updates
      const pollInterval = setInterval(async () => {
        try {
          const pollResponse = await fetch(
            `${API_BASE_URL}/admin/backup/progress/${sessionId}`,
            {
              headers: {
                ...getHeaders(),
                Accept: 'application/json',
              },
            },
          );

          if (pollResponse.ok) {
            const data = await pollResponse.json();
            if (data.percentage !== undefined) {
              setBackupProgress(data.percentage === -1 ? 0 : data.percentage);
              setProgressMessage(data.message || '');

              if (data.percentage === 100) {
                setBackupInProgress(false);
                setProgressMessage('');
                toast.success('Backup completed successfully');
                fetchBackups();
                fetchBackupStatus();
                clearInterval(pollInterval);
              } else if (data.percentage === -1) {
                setBackupInProgress(false);
                setProgressMessage('');
                toast.error(data.message || 'Backup failed');
                clearInterval(pollInterval);
              }
            }
          } else {
            throw new Error('Polling failed');
          }
        } catch (pollError) {
          console.error('Polling error:', pollError);
          toast.error('Progress tracking failed');
          setBackupInProgress(false);
          setProgressMessage('');
          clearInterval(pollInterval);
        }
      }, 500);
    } catch (error: any) {
      console.error('Backup failed:', error);
      toast.error('Backup failed: ' + error.message);
      setBackupInProgress(false);
      setProgressMessage('');
    }
  };

  const handleRestore = async (
    filename: string,
    location: 'local' | 'cloud',
  ) => {
    setRestoreInProgress(true);

    try {
      const response = await fetch(`${API_BASE_URL}/admin/backup/restore`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({ filename, location }),
      });

      const result = await response.json();

      if (result.success) {
        setIntegrityStatus({
          ok: result.integrityChecked ?? true,
          message: result.message || 'Integrity check passed',
        });
        toast.success('Restore completed successfully');
      } else {
        toast.error(result.error || 'Restore failed');
      }

      await fetchBackups();
      await fetchBackupStatus();
    } catch (error: any) {
      console.error('Restore failed:', error);
      toast.error('Restore failed: ' + error.message);
    } finally {
      setRestoreInProgress(false);
    }
  };

  const handleScheduleSave = async () => {
    try {
      // Map frequency to cron expression
      const freqCronMap: { [key: string]: string } = {
        hourly: '0 * * * *',
        daily: '0 2 * * *',
        weekly: '0 2 * * 1',
      };

      const payload = {
        autoSchedule: scheduleEnabled,
        scheduleCron: freqCronMap[scheduleFreq] || '0 2 * * *',
        retentionDays: Math.max(1, Math.min(30, retentionDays)), // Clamp to 1-30 days
      };

      const response = await fetch(`${API_BASE_URL}/admin/backup/config`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        toast.success('Scheduling configuration saved successfully');
        fetchBackupStatus(); // Refresh status to show updated config
      } else {
        toast.error('Failed to save scheduling configuration');
      }
    } catch (error: any) {
      console.error('Save schedule failed:', error);
      toast.error('Failed to save scheduling configuration: ' + error.message);
    }
  };

  const getDiskUsageInfo = () => {
    if (!status?.diskSpace) {
      return {
        percentage: 0,
        status: 'Unknown',
        statusColor: 'text-gray-500',
        warning: false,
      };
    }

    const percentage =
      ((status.diskSpace.total - status.diskSpace.available) /
        status.diskSpace.total) *
      100;
    const availableBytes = status.diskSpace.available;
    const warning = availableBytes < 1024 * 1024 * 1024; // 1GB

    return {
      percentage: Math.round(percentage * 10) / 10, // Round to 1 decimal
      status: `${percentage.toFixed(1)}%`,
      statusColor: warning ? 'text-orange-500' : 'text-green-500',
      warning,
    };
  };

  const diskInfo = getDiskUsageInfo();

  if (loading) {
    return (
      <div className="container mx-auto p-6">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-gray-200 rounded w-48"></div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="h-32 bg-gray-200 rounded"></div>
            <div className="h-32 bg-gray-200 rounded"></div>
            <div className="h-32 bg-gray-200 rounded"></div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">Database Backups</h1>
        <Button
          onClick={() => {
            fetchBackupStatus();
            fetchBackups();
          }}
        >
          <RefreshCw className="w-4 h-4 mr-2" />
          Refresh
        </Button>
      </div>

      {/* Health Monitoring Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="Last Backup"
          value={status?.lastBackup ? formatDate(status.lastBackup) : 'Never'}
          status="Info"
          statusColor="text-blue-500"
        />

        <StatCard
          label="Backup Count"
          value={status?.backupCount?.toString() || '0'}
          status="Good"
          statusColor="text-green-500"
        />

        <StatCard
          label="Database Size"
          value={status ? formatBytes(status.databaseSize) : 'Unknown'}
          status="Good"
          statusColor="text-purple-500"
        />

        <StatCard
          label="Disk Usage"
          value={diskInfo.status}
          status={diskInfo.warning ? 'Warning' : 'Good'}
          statusColor={diskInfo.statusColor}
        />
      </div>

      {/* Action Buttons */}
      <Card>
        <CardHeader>
          <CardTitle>Backup Operations</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-4 flex-wrap">
            <Button
              onClick={() => handleBackup(false)}
              disabled={backupInProgress}
              className="flex items-center gap-2"
            >
              <Database className="w-4 h-4" />
              {backupInProgress ? 'Backing up...' : 'Backup Now'}
            </Button>

            {status?.cloudEnabled && (
              <Button
                variant="outline"
                onClick={() => handleBackup(true)}
                disabled={backupInProgress}
                className="flex items-center gap-2"
              >
                <Upload className="w-4 h-4" />
                {backupInProgress ? 'Backing up...' : 'Backup to Cloud'}
              </Button>
            )}

            {status?.autoSchedule && (
              <Badge variant="secondary" className="flex items-center gap-1">
                <Clock className="w-3 h-3" />
                Auto-scheduled
              </Badge>
            )}
          </div>

          {backupInProgress && (
            <div className="space-y-2">
              <div className="flex justify-between text-sm">
                <span>Backup Progress</span>
                <span>{backupProgress}%</span>
              </div>
              <Progress value={backupProgress} className="w-full" />
              {progressMessage && (
                <p className="text-sm text-muted-foreground">
                  {progressMessage}
                </p>
              )}
            </div>
          )}

          {status?.diskSpace &&
            status.diskSpace.available < 1024 * 1024 * 1024 && (
              <div className="flex items-center gap-2 p-3 bg-yellow-50 border border-yellow-200 rounded-md">
                <AlertTriangle className="w-4 h-4 text-yellow-600" />
                <span className="text-sm text-yellow-800">
                  Low disk space available:{' '}
                  {formatBytes(status.diskSpace.available)}
                </span>
              </div>
            )}
        </CardContent>
      </Card>

      {/* Scheduling & Policy */}
      <Card>
        <CardHeader>
          <CardTitle>Scheduling & Policy</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <div className="text-base font-medium">Automatic Backups</div>
              <div className="text-sm text-muted-foreground">
                Enable automatic scheduled backups
              </div>
            </div>
            <Switch
              checked={scheduleEnabled}
              onCheckedChange={setScheduleEnabled}
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Backup Frequency</label>
              <Select value={scheduleFreq} onValueChange={setScheduleFreq}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="hourly">Hourly</SelectItem>
                  <SelectItem value="daily">Daily at 2:00 AM</SelectItem>
                  <SelectItem value="weekly">
                    Weekly on Monday at 2:00 AM
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Retention Days</label>
              <input
                type="number"
                min="1"
                max="30"
                value={retentionDays}
                onChange={(e) =>
                  setRetentionDays(parseInt(e.target.value) || 7)
                }
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
              />
              <div className="text-sm text-muted-foreground">
                Days to keep backups (1-30)
              </div>
            </div>
          </div>

          <Button onClick={handleScheduleSave} className="w-full">
            Save Configuration
          </Button>
        </CardContent>
      </Card>

      {/* Backup List */}
      <Card>
        <CardHeader>
          <CardTitle>Available Backups</CardTitle>
        </CardHeader>
        {integrityStatus && (
          <div className="mb-4">
            <Alert variant={integrityStatus.ok ? 'default' : 'destructive'}>
              <CheckCircle className={`w-4 h-4`} />
              <AlertDescription>{integrityStatus.message}</AlertDescription>
            </Alert>
          </div>
        )}
        <CardContent>
          {backups.length === 0 ? (
            <div className="text-center py-8 text-gray-500">
              <Database className="w-12 h-12 mx-auto mb-4 opacity-50" />
              <p>No backups available</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Filename</TableHead>
                  <TableHead>Size</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Location</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {backups.map((backup) => (
                  <TableRow key={backup.filename}>
                    <TableCell className="font-medium">
                      {backup.filename}
                    </TableCell>
                    <TableCell>{formatBytes(backup.size)}</TableCell>
                    <TableCell>{formatDate(backup.createdAt)}</TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          backup.location === 'cloud' ? 'default' : 'secondary'
                        }
                      >
                        {backup.location}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-2">
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={restoreInProgress}
                              className="flex items-center gap-1"
                            >
                              <Download className="w-3 h-3" />
                              Restore
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>
                                Restore Database
                              </AlertDialogTitle>
                              <AlertDialogDescription>
                                Are you sure you want to restore the database
                                from {backup.filename}? This will replace the
                                current database. Make sure you have a backup of
                                the current state.
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>Cancel</AlertDialogCancel>
                              <AlertDialogAction
                                onClick={() =>
                                  handleRestore(
                                    backup.filename,
                                    backup.location,
                                  )
                                }
                                className="bg-red-600 hover:bg-red-700"
                              >
                                Restore
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>

                        <Button
                          variant="outline"
                          size="sm"
                          disabled
                          className="flex items-center gap-1 text-gray-400 cursor-not-allowed"
                          title="Download not yet supported"
                        >
                          <Download className="w-3 h-3" />
                          Download
                        </Button>

                        <Button
                          variant="outline"
                          size="sm"
                          disabled
                          className="flex items-center gap-1 text-red-400 cursor-not-allowed"
                          title="Delete not yet supported"
                        >
                          <Trash2 className="w-3 h-3" />
                          Delete
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Success/Error Messages */}
      {/* TODO: Add toast notifications for operations */}
      <Toaster position="top-right" />
    </div>
  );
}
