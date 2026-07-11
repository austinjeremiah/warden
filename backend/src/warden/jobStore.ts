/**
 * In-memory job ledger for Warden. One Job tracks a full buyer->Warden->provider
 * flow across both orders. Kept in memory (MVP); the audit log (settlement.ts)
 * is the durable record. Indexed by the various IDs so any incoming WS event can
 * be routed back to its job regardless of which leg fired it.
 */
export type JobStatus =
  | 'accepted' // Order A negotiation accepted, waiting for buyer to pay
  | 'buyer_paid' // buyer funded escrow A; hiring target provider
  | 'b_created' // Order B created on-chain; paying it
  | 'b_paid' // escrow B funded; waiting for provider delivery
  | 'validating' // provider delivered; running quality gate
  | 'settled_pass' // gate passed; delivered Order A to buyer
  | 'settled_fail' // gate failed; rejected Order A -> buyer refunded
  | 'error';

export interface Job {
  orderAId: string;
  negotiationAId: string;
  buyerInput: string;
  targetServiceId: string;
  acceptanceCriteria: string;
  requiredFields?: string[];
  negotiationBId?: string;
  orderBId?: string;
  status: JobStatus;
  createdAt: number;
}

export class JobStore {
  private byOrderA = new Map<string, Job>();
  private byNegotiationB = new Map<string, Job>();
  private byOrderB = new Map<string, Job>();

  create(job: Job): void {
    this.byOrderA.set(job.orderAId, job);
  }
  setNegotiationB(job: Job, negotiationBId: string): void {
    job.negotiationBId = negotiationBId;
    this.byNegotiationB.set(negotiationBId, job);
  }
  setOrderB(job: Job, orderBId: string): void {
    job.orderBId = orderBId;
    this.byOrderB.set(orderBId, job);
  }

  byOrderAId(id: string): Job | undefined {
    return this.byOrderA.get(id);
  }
  byNegotiationBId(id: string): Job | undefined {
    return this.byNegotiationB.get(id);
  }
  byOrderBId(id: string): Job | undefined {
    return this.byOrderB.get(id);
  }
  all(): Job[] {
    return [...this.byOrderA.values()];
  }
}
