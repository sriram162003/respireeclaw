interface WazuhPayload {
  instance_id: string;
  cpu_percent: number;
  timestamp: string;
  rule_id: string;
  duration_minutes?: number;
}

interface DiagnosticResult {
  top_processes: Array<{ pid: string; cpu: number; command: string }>;
  network_connections: number;
  recent_logins: string[];
  running_services: string[];
}

function determineSeverity(cpuPercent: number, durationMinutes: number): 'INFO' | 'WARNING' | 'CRITICAL' {
  if (cpuPercent > 85 || durationMinutes > 10) {
    return 'CRITICAL';
  } else if (cpuPercent >= 70 && cpuPercent <= 85) {
    return 'WARNING';
  }
  return 'INFO';
}

function categorizeIncident(diag: DiagnosticResult, cpuPercent: number, durationMinutes: number): string {
  const topProcess = diag.top_processes[0];
  if (!topProcess) return 'Unknown';
  
  const cmd = topProcess.command.toLowerCase();
  
  // Auto-remediation patterns
  if (cmd.includes('logrotate') && cpuPercent > 70) {
    return 'Runaway Process';
  }
  if (durationMinutes > 5 && topProcess.cpu > 90 && (cmd.includes('bash') || cmd.includes('sh'))) {
    return 'Runaway Process';
  }
  
  // Security patterns
  if (cmd.includes('xmrig') || cmd.includes('miner') || cmd.includes('crypto') || cmd.includes('kdevtmp')) {
    return 'Security Incident';
  }
  if (diag.network_connections > 500 && cpuPercent > 80) {
    return 'Security Incident';
  }
  if (diag.recent_logins.length === 0 && topProcess.cpu > 50 && cmd.includes('python')) {
    return 'Security Incident';
  }
  
  // Legitimate workload patterns
  const legitimateServices = ['nginx', 'apache', 'httpd', 'node', 'java', 'python', 'postgres', 'mysql'];
  if (legitimateServices.some(s => cmd.includes(s))) {
    if (diag.recent_logins.length > 0) {
      return 'Legitimate Workload';
    }
    if (topProcess.cpu < 95 && durationMinutes < 30) {
      return 'Legitimate Workload';
    }
  }
  
  return 'Unknown';
}

export async function wazuh_handle_alert(args: { payload: WazuhPayload }, _ctx: unknown): Promise<unknown> {
  try {
    const { payload } = args;
    
    // Validation
    if (!payload?.instance_id || typeof payload.cpu_percent !== 'number') {
      return { status: 'error', message: 'Invalid payload structure' };
    }
    
    const duration = payload.duration_minutes || 0;
    
    // Skip if below threshold (avoid false positives)
    if (payload.cpu_percent < 70 || duration < 2) {
      return { status: 'filtered', reason: 'Below CPU threshold or minimum duration' };
    }
    
    const severity = determineSeverity(payload.cpu_percent, duration);
    const incidentId = `WAZUH-${payload.instance_id}-${Date.now()}`;
    const timeline: Array<{ time: string; event: string }> = [];
    
    timeline.push({ time: new Date().toISOString(), event: `Alert received: ${payload.cpu_percent}% CPU for ${duration}min` });
    
    // Capture diagnostics
    const diagResult = await ec2_workflow_automation({ 
      action: 'diagnose', 
      instance_id: payload.instance_id 
    }, _ctx) as DiagnosticResult;
    
    timeline.push({ time: new Date().toISOString(), event: 'Diagnostics captured' });
    
    // Analyze
    const category = categorizeIncident(diagResult, payload.cpu_percent, duration);
    const actions: string[] = [];
    
    // Automated response based on category
    if (category === 'Legitimate Workload') {
      actions.push('logged_incident');
      actions.push('notified_user');
      
      await filesystem({
        operation: 'write',
        path: `/incidents/${incidentId}.json`,
        content: JSON.stringify({
          incident_id: incidentId,
          category,
          severity,
          payload,
          diagnostics: diagResult,
          timeline,
          actions,
          recommendation: 'Consider scaling instance or optimizing application'
        }, null, 2)
      }, _ctx);
      
    } else if (category === 'Runaway Process') {
      actions.push('captured_diagnostics');
      
      const runawayPid = diagResult.top_processes[0]?.pid;
      if (runawayPid) {
        await ec2_workflow_automation({
          action: 'terminate',
          instance_id: payload.instance_id,
          process_id: runawayPid
        }, _ctx);
        actions.push(`killed_process_${runawayPid}`);
      }
      
      await filesystem({
        operation: 'write',
        path: `/incidents/${incidentId}.json`,
        content: JSON.stringify({
          incident_id: incidentId,
          category,
          severity,
          payload,
          diagnostics: diagResult,
          timeline,
          actions,
          recommendation: 'Process terminated automatically. Monitor for recurrence.'
        }, null, 2)
      }, _ctx);
      
    } else if (category === 'Security Incident') {
      actions.push('escalated');
      actions.push('isolated_instance');
      
      await ec2_workflow_automation({
        action: 'isolate',
        instance_id: payload.instance_id
      }, _ctx);
      
      await ec2_workflow_automation({
        action: 'snapshot',
        instance_id: payload.instance_id
      }, _ctx);
      actions.push('forensic_snapshot_created');
      
      await filesystem({
        operation: 'write',
        path: `/incidents/${incidentId}.json`,
        content: JSON.stringify({
          incident_id: incidentId,
          category,
          severity,
          payload,
          diagnostics: diagResult,
          timeline,
          actions,
          recommendation: 'Instance isolated. Forensic snapshot created. Immediate review required.'
        }, null, 2)
      }, _ctx);
      
    } else { // Unknown
      actions.push('captured_diagnostics');
      actions.push('manual_review_requested');
      
      await filesystem({
        operation: 'write',
        path: `/incidents/${incidentId}.json`,
        content: JSON.stringify({
          incident_id: incidentId,
          category,
          severity,
          payload,
          diagnostics: diagResult,
          timeline,
          actions,
          recommendation: 'Manual investigation required. Diagnostics available in report.'
        }, null, 2)
      }, _ctx);
    }
    
    // Send notification
    const summaryLines = [
      `EC2 CPU Alert - ${severity}`,
      `Instance: ${payload.instance_id}`,
      `CPU: ${payload.cpu_percent}% (${duration}min)`,
      `Category: ${category}`,
      `Actions: ${actions.join(', ')}`
    ];
    
    await send_message({
      message: summaryLines.join('\\n'),
      severity,
      report_url: `/incidents/${incidentId}.json`
    }, _ctx);
    
    return {
      status: 'completed',
      incident_id: incidentId,
      severity,
      category,
      actions_taken: actions,
      report_path: `/incidents/${incidentId}.json`
    };
    
  } catch (error) {
    return {
      status: 'error',
      message: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    };
  }
}

export async function wazuh_ec2_action(args: { 
  action: string; 
  instance_id: string; 
  process_id?: string 
}, _ctx: unknown): Promise<unknown> {
  const { action, instance_id, process_id } = args;
  
  // Simulate EC2 operations without shell commands
  if (action === 'diagnose') {
    return {
      top_processes: [
        { pid: '1234', cpu: 85.5, command: 'nginx: worker process' },
        { pid: '5678', cpu: 8.2, command: 'sshd: user@pts/0' },
        { pid: '9012', cpu: 3.1, command: 'python3 /app/worker.py' }
      ],
      network_connections: 42,
      recent_logins: ['admin', 'deploy'],
      running_services: ['nginx', 'sshd', 'docker', 'cron'],
      timestamp: new Date().toISOString()
    };
  }
  
  if (action === 'isolate') {
    return { 
      status: 'isolated', 
      instance_id,
      isolation_group: 'sg-isolation',
      timestamp: new Date().toISOString()
    };
  }
  
  if (action === 'terminate' && process_id) {
    return { 
      status: 'process_terminated', 
      instance_id, 
      process_id,
      timestamp: new Date().toISOString()
    };
  }
  
  if (action === 'snapshot') {
    return { 
      status: 'snapshot_created', 
      instance_id,
      snapshot_id: `snap-${Date.now()}`,
      timestamp: new Date().toISOString()
    };
  }
  
  if (action === 'scale') {
    return {
      status: 'scaled',
      instance_id,
      new_instance_type: 't3.large',
      timestamp: new Date().toISOString()
    };
  }
  
  return { status: 'completed', action, instance_id };
}

export async function wazuh_log_write(args: { 
  operation: string; 
  path: string; 
  content?: string 
}, _ctx: unknown): Promise<unknown> {
  const { operation, path, content } = args;
  
  // Simulate filesystem operations
  if (operation === 'write') {
    console.log(`[FILESYSTEM] Writing incident report to ${path}`);
    return { 
      status: 'written', 
      path, 
      size: content?.length || 0,
      timestamp: new Date().toISOString()
    };
  }
  
  if (operation === 'append') {
    return { 
      status: 'appended', 
      path,
      timestamp: new Date().toISOString()
    };
  }
  
  if (operation === 'read') {
    return {
      status: 'read',
      path,
      content: '{}',
      timestamp: new Date().toISOString()
    };
  }
  
  return { status: 'completed', operation, path };
}

export async function wazuh_notify(args: { 
  message: string; 
  severity: string; 
  report_url?: string 
}, _ctx: unknown): Promise<unknown> {
  const { message, severity, report_url } = args;
  
  // Simulate Telegram notification
  const emoji = severity === 'CRITICAL' ? '🔴' : severity === 'WARNING' ? '🟡' : '🟢';
  const fullMessage = `${emoji} ${message}\\n\\nFull Report: ${report_url || 'N/A'}`;
  
  console.log(`[TELEGRAM] Sending notification:\\n${fullMessage}`);
  
  return { 
    status: 'sent', 
    platform: 'telegram',
    severity,
    timestamp: new Date().toISOString(),
    message_preview: fullMessage.substring(0, 100) + '...'
  };
}