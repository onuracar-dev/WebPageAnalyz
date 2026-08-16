import {
  Activity,
  Crosshair,
  FileText,
  Home,
  LifeBuoy,
  Plug,
  Search,
  Settings,
} from 'lucide-react';
import type { PortalNavItem } from './PortalShell';

export const workspaceNav: PortalNavItem[] = [
  { id: 'overview', label: 'Overview', icon: Home },
  { id: 'findings', label: 'Findings', icon: Search },
  { id: 'reports', label: 'Reports', icon: FileText },
  { id: 'targets', label: 'Targets', icon: Crosshair },
  { id: 'integrations', label: 'Integrations', icon: Plug },
  { id: 'support', label: 'Support', icon: LifeBuoy },
  { id: 'status', label: 'System Status', icon: Activity },
  { id: 'settings', label: 'Settings', icon: Settings },
];
