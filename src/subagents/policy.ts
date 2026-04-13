export interface AgentPolicy {
  secretPaths: string[];
  permissions: string[];
  expiresAfterSeconds: number;
  maxValueEth: string | null;
  allowedChains: string[];
  allowedAddresses: string[];
}

export class PolicyBuilder {
  private paths: string[] = [];
  private perms: string[] = ["read", "write"];
  private ttl = 300;
  private maxValue: string | null = null;
  private chains: string[] = [];
  private addresses: string[] = [];

  allowPath(glob: string): this {
    this.paths.push(glob);
    return this;
  }

  readOnly(): this {
    this.perms = ["read"];
    return this;
  }

  expireAfter(seconds: number): this {
    this.ttl = seconds;
    return this;
  }

  capValue(ethMax: string): this {
    this.maxValue = ethMax;
    return this;
  }

  allowChains(...chains: string[]): this {
    this.chains.push(...chains);
    return this;
  }

  allowAddresses(...addresses: string[]): this {
    this.addresses.push(...addresses);
    return this;
  }

  build(): AgentPolicy {
    return {
      secretPaths: [...this.paths],
      permissions: [...this.perms],
      expiresAfterSeconds: this.ttl,
      maxValueEth: this.maxValue,
      allowedChains: [...this.chains],
      allowedAddresses: [...this.addresses],
    };
  }
}

/**
 * Pre-built policy: read-only access to a single secret path,
 * 5-minute TTL, no transaction capabilities.
 */
export function ephemeralReadPolicy(secretPath: string): AgentPolicy {
  return new PolicyBuilder()
    .allowPath(secretPath)
    .readOnly()
    .expireAfter(300)
    .build();
}
