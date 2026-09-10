-- 为公开取码查询提供可稳定命中的部分索引，避免 COALESCE 导致全表扫描
CREATE INDEX idx_messages_delivered_to_public_code
  ON messages(delivered_to, sort_at DESC, id DESC)
  WHERE direction = 'incoming' AND folder = 'inbox' AND status = 'ready';

CREATE INDEX idx_messages_mailbox_public_code
  ON messages(mailbox_address, sort_at DESC, id DESC)
  WHERE direction = 'incoming' AND folder = 'inbox' AND status = 'ready';
