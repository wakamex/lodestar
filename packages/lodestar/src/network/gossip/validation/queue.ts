import {AbortSignal} from "@chainsafe/abort-controller";
import {IMetrics} from "../../../metrics";
import {JobQueue, JobQueueOpts, QueueType} from "../../../util/queue";
import {GossipType, GossipValidatorFn} from "../interface";

/**
 * Numbers from https://github.com/sigp/lighthouse/blob/b34a79dc0b02e04441ba01fd0f304d1e203d877d/beacon_node/network/src/beacon_processor/mod.rs#L69
 */
const gossipQueueOpts: {[K in GossipType]: Pick<JobQueueOpts, "maxLength" | "type" | "maxConcurrency">} = {
  [GossipType.beacon_block]: {maxLength: 1024, type: QueueType.FIFO},
  // this is different from lighthouse's, there are more gossip aggregate_and_proof than gossip block
  [GossipType.beacon_aggregate_and_proof]: {maxLength: 4096, type: QueueType.LIFO, maxConcurrency: 16},
  [GossipType.beacon_attestation]: {maxLength: 16384, type: QueueType.LIFO, maxConcurrency: 64},
  [GossipType.voluntary_exit]: {maxLength: 4096, type: QueueType.FIFO},
  [GossipType.proposer_slashing]: {maxLength: 4096, type: QueueType.FIFO},
  [GossipType.attester_slashing]: {maxLength: 4096, type: QueueType.FIFO},
  [GossipType.sync_committee_contribution_and_proof]: {maxLength: 4096, type: QueueType.LIFO},
  [GossipType.sync_committee]: {maxLength: 4096, type: QueueType.LIFO},
};

/**
 * Wraps a GossipValidatorFn with a queue, to limit the processing of gossip objects by type.
 *
 * A queue here is essential to protect against DOS attacks, where a peer may send many messages at once.
 * Queues also protect the node against overloading. If the node gets bussy with an expensive epoch transition,
 * it may buffer too many gossip objects causing an Out of memory (OOM) error. With a queue the node will reject
 * new objects to fit its current throughput.
 *
 * Queues may buffer objects by
 *  - topic '/eth2/0011aabb/beacon_attestation_0/ssz_snappy'
 *  - type `GossipType.beacon_attestation`
 *  - all objects in one queue
 *
 * By topic is too specific, so by type groups all similar objects in the same queue. All in the same won't allow
 * to customize different queue behaviours per object type (see `gossipQueueOpts`).
 */
export function wrapWithQueue(
  gossipValidatorFn: GossipValidatorFn,
  type: GossipType,
  signal: AbortSignal,
  metrics: IMetrics | null
): GossipValidatorFn {
  const jobQueue = new JobQueue(
    {signal, ...gossipQueueOpts[type]},
    metrics
      ? {
          length: metrics.gossipValidationQueueLength.child({topic: type}),
          droppedJobs: metrics.gossipValidationQueueDroppedJobs.child({topic: type}),
          jobTime: metrics.gossipValidationQueueJobTime.child({topic: type}),
          jobWaitTime: metrics.gossipValidationQueueJobWaitTime.child({topic: type}),
        }
      : undefined
  );

  return async function gossipValidatorFnWithQueue(topicStr, gossipMsg) {
    await jobQueue.push(async () => gossipValidatorFn(topicStr, gossipMsg));
  };
}
