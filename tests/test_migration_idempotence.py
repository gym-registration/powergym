"""
Test: Verification of weight_logs schema migration idempotence and non-destructiveness:
1. Runs against a copy of an existing table with data (including multi-day and duplicate entries):
   - Proves non-destructive behavior on existing records.
   - Proves deduplication retains the latest record per member per Manila calendar day.
   - Proves it is idempotent when run a second time.
2. Runs against a fresh install schema:
   - Proves fresh table creation includes log_date and UNIQUE constraint.
   - Proves it is idempotent when migration runs once and twice.
"""
import os
import sys
from datetime import datetime, timezone, timedelta, date

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
from app import app, db
from sqlalchemy import text

def run_migration_on_table(conn, table_name):
    # 1. Fresh install DDL
    conn.execute(text(f"""
        CREATE TABLE IF NOT EXISTS {table_name} (
            id INT AUTO_INCREMENT PRIMARY KEY,
            member_id INT NOT NULL,
            weight_kg DECIMAL(5,2) NOT NULL,
            logged_at DATETIME NOT NULL,
            log_date DATE NOT NULL,
            INDEX (member_id),
            UNIQUE KEY uq_{table_name}_member_log_date (member_id, log_date)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """))
    conn.commit()

    # 2. Add column log_date if missing
    res_col = conn.execute(text(f"SHOW COLUMNS FROM {table_name} LIKE 'log_date'"))
    if res_col.fetchone() is None:
        conn.execute(text(f"ALTER TABLE {table_name} ADD COLUMN log_date DATE NULL"))
        conn.commit()
        conn.execute(text(f"UPDATE {table_name} SET log_date = DATE(DATE_ADD(logged_at, INTERVAL 8 HOUR)) WHERE log_date IS NULL"))
        conn.commit()

    # 3. Deduplicate (keep latest logged_at / highest id per member_id + log_date)
    conn.execute(text(f"""
        DELETE w1 FROM {table_name} w1
        INNER JOIN {table_name} w2
            ON w1.member_id = w2.member_id
            AND w1.log_date = w2.log_date
            AND (w1.logged_at < w2.logged_at OR (w1.logged_at = w2.logged_at AND w1.id < w2.id))
    """))
    conn.commit()

    # 4. Modify column to NOT NULL if needed
    res_col = conn.execute(text(f"SHOW COLUMNS FROM {table_name} LIKE 'log_date'"))
    col_row = res_col.fetchone()
    if col_row and col_row[2] == 'YES':
        conn.execute(text(f"ALTER TABLE {table_name} MODIFY COLUMN log_date DATE NOT NULL"))
        conn.commit()

    # 5. Add unique key if missing
    idx_name = f"uq_{table_name}_member_log_date"
    res_idx = conn.execute(text(f"SHOW INDEX FROM {table_name} WHERE Key_name = '{idx_name}'"))
    if res_idx.fetchone() is None:
        conn.execute(text(f"ALTER TABLE {table_name} ADD UNIQUE KEY {idx_name} (member_id, log_date)"))
        conn.commit()

def test_migration():
    print("=== Testing Migration Idempotence and Non-Destructiveness ===")
    with app.app_context():
        with db.engine.connect() as conn:
            # Cleanup any existing test tables
            conn.execute(text("DROP TABLE IF EXISTS test_weight_logs_existing"))
            conn.execute(text("DROP TABLE IF EXISTS test_weight_logs_fresh"))
            conn.commit()

            try:
                # -------------------------------------------------------------
                # SCENARIO A: Existing Database Migration (table without log_date, with data & duplicates)
                # -------------------------------------------------------------
                print("\n[Scenario A] Existing database with pre-migration schema and existing rows...")
                conn.execute(text("""
                    CREATE TABLE test_weight_logs_existing (
                        id INT AUTO_INCREMENT PRIMARY KEY,
                        member_id INT NOT NULL,
                        weight_kg DECIMAL(5,2) NOT NULL,
                        logged_at DATETIME NOT NULL,
                        INDEX (member_id)
                    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
                """))
                conn.commit()

                # Seed test data:
                # Day 1: single weigh-in
                conn.execute(text("INSERT INTO test_weight_logs_existing (id, member_id, weight_kg, logged_at) VALUES (1, 101, 75.0, '2026-09-18 02:00:00')"))
                # Day 2: two weigh-ins (duplicate on Manila date 2026-09-19)
                conn.execute(text("INSERT INTO test_weight_logs_existing (id, member_id, weight_kg, logged_at) VALUES (2, 101, 74.5, '2026-09-19 01:00:00')"))
                conn.execute(text("INSERT INTO test_weight_logs_existing (id, member_id, weight_kg, logged_at) VALUES (3, 101, 74.2, '2026-09-19 08:00:00')"))
                # Member 102: single weigh-in
                conn.execute(text("INSERT INTO test_weight_logs_existing (id, member_id, weight_kg, logged_at) VALUES (4, 102, 65.0, '2026-09-19 03:00:00')"))
                conn.commit()

                print("  Initial row count: 4")

                # PASS 1: Run migration on existing table
                print("  Executing migration (Pass 1)...")
                run_migration_on_table(conn, 'test_weight_logs_existing')

                # Verify rows after Pass 1:
                # Member 101 Day 1 (id 1, 75.0 kg, log_date 2026-09-18) must survive
                # Member 101 Day 2 (id 3, 74.2 kg, log_date 2026-09-19) must survive; id 2 must be pruned
                # Member 102 Day 2 (id 4, 65.0 kg, log_date 2026-09-19) must survive
                rows = conn.execute(text("SELECT id, member_id, weight_kg, log_date FROM test_weight_logs_existing ORDER BY id")).fetchall()
                print(f"  Rows remaining after migration deduplication: {len(rows)}")
                for r in rows:
                    print(f"    id={r[0]}, member={r[1]}, weight={r[2]}, log_date={r[3]}")
                assert len(rows) == 3, f"Expected 3 rows, got {len(rows)}"
                assert [r[0] for r in rows] == [1, 3, 4], "Expected IDs 1, 3, 4"
                print("  [PASS] Existing data successfully backfilled and deduplicated (latest record preserved).")

                # PASS 2: Run migration second time (Idempotence check)
                print("  Executing migration a second time (Pass 2 - Idempotence check)...")
                run_migration_on_table(conn, 'test_weight_logs_existing')
                rows_pass2 = conn.execute(text("SELECT id, member_id, weight_kg, log_date FROM test_weight_logs_existing ORDER BY id")).fetchall()
                assert len(rows_pass2) == 3
                assert [r[0] for r in rows_pass2] == [1, 3, 4]
                print("  [PASS] Pass 2 completed with zero errors and zero unwanted data modifications (idempotent).")

                # Verify UNIQUE constraint enforcement
                print("  Verifying UNIQUE constraint prevents duplicate entries...")
                try:
                    conn.execute(text("INSERT INTO test_weight_logs_existing (member_id, weight_kg, logged_at, log_date) VALUES (101, 74.0, NOW(), '2026-09-19')"))
                    conn.commit()
                    assert False, "Should have failed due to duplicate entry on (member_id, log_date)"
                except Exception as e:
                    conn.rollback()
                    assert "Duplicate entry" in str(e) or "1062" in str(e)
                    print("  [PASS] Database constraint rejected duplicate insert as expected.")

                # -------------------------------------------------------------
                # SCENARIO B: Fresh Install
                # -------------------------------------------------------------
                print("\n[Scenario B] Fresh install (table does not exist)...")
                # PASS 1: Fresh install
                print("  Executing migration on non-existent table (Pass 1)...")
                run_migration_on_table(conn, 'test_weight_logs_fresh')
                cols = conn.execute(text("SHOW COLUMNS FROM test_weight_logs_fresh")).fetchall()
                col_names = [c[0] for c in cols]
                assert 'log_date' in col_names, "log_date column missing"
                indexes = conn.execute(text("SHOW INDEX FROM test_weight_logs_fresh WHERE Key_name = 'uq_test_weight_logs_fresh_member_log_date'")).fetchall()
                assert len(indexes) == 2, f"Expected composite unique index with 2 parts, got {len(indexes)}"
                print("  [PASS] Fresh table created with log_date and unique key.")

                # PASS 2: Fresh install run second time
                print("  Executing migration on fresh table a second time (Pass 2 - Idempotence check)...")
                run_migration_on_table(conn, 'test_weight_logs_fresh')
                print("  [PASS] Pass 2 on fresh install completed cleanly (idempotent).")

            finally:
                conn.execute(text("DROP TABLE IF EXISTS test_weight_logs_existing"))
                conn.execute(text("DROP TABLE IF EXISTS test_weight_logs_fresh"))
                conn.commit()
                print("\n[Cleanup] Test tables dropped successfully.")

if __name__ == '__main__':
    test_migration()
