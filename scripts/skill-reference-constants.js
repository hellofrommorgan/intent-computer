/**
 * Single source of truth for SKILL.md reference normalization during sync.
 * Keep queue paths/schema and placeholder syntax mappings here.
 */

export const SKILL_REFERENCE_CONSTANTS = {
  queue: {
    canonicalPath: "ops/queue/queue.json",
    legacyPaths: ["ops/queue.yaml", "ops/queue/queue.yaml"],
    canonicalSchemaLabel: "version: 1",
  },
  vocabulary: {
    // Normalize historical plural alias to one key.
    aliases: {
      topic_maps: "topic_map_plural",
    },
  },
  domainPlaceholderMap: {
    "{DOMAIN:notes}": "{vocabulary.notes}",
    "{DOMAIN:note}": "{vocabulary.note}",
    "{DOMAIN:note_plural}": "{vocabulary.note_plural}",
    "{DOMAIN:topic map}": "{vocabulary.topic_map}",
    "{DOMAIN:topic maps}": "{vocabulary.topic_map_plural}",
    "{DOMAIN:inbox}": "{vocabulary.inbox}",
    "{DOMAIN:process}": "{vocabulary.cmd_reduce}",
    "{DOMAIN:connect}": "{vocabulary.cmd_reflect}",
    "{DOMAIN:reduce}": "{vocabulary.cmd_reduce}",
    "{DOMAIN:reweave}": "{vocabulary.cmd_reweave}",
    "{DOMAIN:verify}": "{vocabulary.cmd_verify}",
    "{DOMAIN:remember}": "{vocabulary.cmd_remember}",
    "{DOMAIN:rethink}": "{vocabulary.cmd_rethink}",
    "{DOMAIN:next}": "{vocabulary.cmd_next}",
    "{DOMAIN:architect}": "{vocabulary.architect}",
    "{DOMAIN:pipeline}": "{vocabulary.cmd_process}",
    "{DOMAIN:seed}": "{vocabulary.cmd_seed}",
    "{DOMAIN:reseed}": "{vocabulary.cmd_reseed}",
    "{DOMAIN:orchestrate}": "{vocabulary.cmd_process}",
    "{DOMAIN:maintain}": "{vocabulary.cmd_rethink}",
    "{DOMAIN:extraction_categories}": "{vocabulary.extraction_categories}",
  },
};
