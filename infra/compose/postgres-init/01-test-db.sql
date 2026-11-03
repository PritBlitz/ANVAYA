-- Separate databases for automated tests so test runs never touch dev data.
-- anvaya_test_a / anvaya_test_b let two checkouts run the suite in parallel.
CREATE DATABASE anvaya_test OWNER anvaya;
CREATE DATABASE anvaya_test_a OWNER anvaya;
CREATE DATABASE anvaya_test_b OWNER anvaya;
