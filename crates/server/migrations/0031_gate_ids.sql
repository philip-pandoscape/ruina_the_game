-- Gates' ids (world-api's GateId), unique across the processes on this database: a connection is
-- addressed through its gate, so another process must know which gate, and where it is. A gate
-- process draws its id when it starts and writes it on its row in `nodes`.
CREATE SEQUENCE gate_ids;
ALTER TABLE nodes ADD COLUMN gate INT;
CREATE INDEX nodes_by_gate ON nodes (gate);
