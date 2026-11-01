export function installMcpOAuth(app: any, options: Record<string, any>): {
  (req: any, res: any, next: (error?: unknown) => void): any;
  enabled: boolean;
  challenge: string;
  verifyAccessToken(token: string): Promise<any>;
  grantOf?(token: string): string | null;
};
