export interface AgentPolicy {
  secretPaths: string[];
  permissions: string[];
  expiresAfterSeconds: number;
  maxValueEth: string | null;
  allowedChains: string[];
  allowedAddresses: string[];
  signingChains: string[];
  messageSigningEnabled: boolean;
  eip712DomainAllowlist: string[];
  eip712DefaultPolicy: "allow" | "block";
}

export class PolicyBuilder {
  private paths: string[] = [];
  private perms: string[] = ["read", "write"];
  private ttl = 300;
  private maxValue: string | null = null;
  private chains: string[] = [];
  private addresses: string[] = [];
  private _signingChains: string[] = [];
  private _messageSigningEnabled = false;
  private _eip712DomainAllowlist: string[] = [];
  private _eip712DefaultPolicy: "allow" | "block" = "block";

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

  allowSigningChains(...chains: string[]): this {
    this._signingChains.push(...chains);
    return this;
  }

  enableMessageSigning(): this {
    this._messageSigningEnabled = true;
    return this;
  }

  allowEip712Domains(...domains: string[]): this {
    this._eip712DomainAllowlist.push(...domains);
    return this;
  }

  setEip712DefaultPolicy(policy: "allow" | "block"): this {
    this._eip712DefaultPolicy = policy;
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
      signingChains: [...this._signingChains],
      messageSigningEnabled: this._messageSigningEnabled,
      eip712DomainAllowlist: [...this._eip712DomainAllowlist],
      eip712DefaultPolicy: this._eip712DefaultPolicy,
    };
  }
}

/**
 * Pre-built policy: read-only access to a single secret path,
 * 5-minute TTL, no transaction or signing capabilities.
 */
export function ephemeralReadPolicy(secretPath: string): AgentPolicy {
  return new PolicyBuilder()
    .allowPath(secretPath)
    .readOnly()
    .expireAfter(300)
    .build();
}
