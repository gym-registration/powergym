-- Email OTP verification — manual SQL (MySQL).
-- app.py also applies all of this automatically on startup; this file is only
-- for running the changes by hand.

-- 1) Verified flag. DEFAULT 1 marks every EXISTING account as verified so
--    nobody (members, staff, admin) is locked out. New self-registrations are
--    inserted by the app with email_verified = 0.
ALTER TABLE users ADD COLUMN email_verified TINYINT(1) NOT NULL DEFAULT 1;

-- 2) One row per user holding the HASHED code. A new code overwrites the row,
--    which is what invalidates the previous one.
CREATE TABLE IF NOT EXISTS email_verification_otps (
    id                INT AUTO_INCREMENT PRIMARY KEY,
    user_id           INT NOT NULL UNIQUE,
    otp_hash          VARCHAR(255) NOT NULL,
    expires_at        DATETIME NOT NULL,
    attempts          INT NOT NULL DEFAULT 0,
    last_sent_at      DATETIME NOT NULL,
    send_count        INT NOT NULL DEFAULT 1,
    send_window_start DATETIME NOT NULL,
    CONSTRAINT fk_email_otp_user FOREIGN KEY (user_id)
        REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 3) Optional manual clean-up (the app does this hourly): unverified > 24h
-- DELETE FROM users WHERE role='member' AND email_verified=0
--   AND created_at < (UTC_TIMESTAMP() - INTERVAL 24 HOUR);
