-- OA 組織資料庫結構（與正式環境 schema.sql 相同，只供本機開發）
CREATE DATABASE IF NOT EXISTS oa_organization_db DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_uca1400_ai_ci;
USE oa_organization_db;

CREATE TABLE IF NOT EXISTS company (
  id BIGINT(19) NOT NULL AUTO_INCREMENT,
  company_code VARCHAR(32) NOT NULL,
  company_name VARCHAR(64) NOT NULL,
  form_company_code VARCHAR(16) NOT NULL,
  case_company_code VARCHAR(16) NOT NULL,
  erp_company_code VARCHAR(16) NULL,
  sort_no INT(10) NOT NULL,
  active TINYINT(3) NOT NULL DEFAULT 1,
  created_by BIGINT(19) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_by BIGINT(19) NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_company_company_code (company_code),
  KEY idx_company_sort_no (sort_no)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE IF NOT EXISTS department (
  id BIGINT(19) NOT NULL AUTO_INCREMENT,
  dept_code VARCHAR(64) NOT NULL,
  dept_name VARCHAR(128) NOT NULL,
  dept_name_en VARCHAR(128) NULL,
  company_id BIGINT(19) NULL,
  parent_id BIGINT(19) NULL,
  manager_id BIGINT(19) NULL,
  if_delete TINYINT(3) NOT NULL DEFAULT 0,
  sort_no INT(10) NOT NULL DEFAULT 0,
  created_by BIGINT(19) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_by BIGINT(19) NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_department_parent_sort (parent_id, sort_no),
  KEY fk_department_company (company_id),
  KEY idx_department_manager_id (manager_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE IF NOT EXISTS department_profile (
  department_id BIGINT(19) NOT NULL,
  is_level1 TINYINT(3) NOT NULL DEFAULT 0,
  is_operation TINYINT(3) NULL,
  level1_dept BIGINT(19) NULL,
  PRIMARY KEY (department_id),
  KEY idx_department_profile_is_level1 (is_level1),
  KEY idx_department_profile_level1_dept (level1_dept)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE IF NOT EXISTS employee_job_post (
  code VARCHAR(64) NOT NULL,
  name VARCHAR(128) NOT NULL,
  name_en VARCHAR(128) NULL,
  sort_no INT(10) NOT NULL DEFAULT 0,
  active TINYINT(3) NOT NULL DEFAULT 1,
  created_by BIGINT(19) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_by BIGINT(19) NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (code),
  KEY idx_employee_job_post_sort_no (sort_no)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE IF NOT EXISTS employee (
  id BIGINT(19) NOT NULL AUTO_INCREMENT,
  employee_no VARCHAR(64) NOT NULL,
  cn_name VARCHAR(64) NOT NULL,
  en_name VARCHAR(64) NULL,
  nick_name VARCHAR(64) NULL,
  sex VARCHAR(16) NULL,
  manager_id BIGINT(19) NULL,
  job_post VARCHAR(64) NULL,
  job_level VARCHAR(64) NULL,
  job_func VARCHAR(64) NULL,
  employee_type VARCHAR(32) NULL,
  job_place VARCHAR(64) NULL,
  company_id BIGINT(19) NULL,
  arrival_day DATE NOT NULL,
  leave_day DATE NULL,
  job_tel VARCHAR(32) NULL,
  job_mobile VARCHAR(32) NULL,
  email VARCHAR(128) NULL,
  created_by BIGINT(19) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_by BIGINT(19) NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_employee_employee_no (employee_no),
  KEY idx_employee_cn_name (cn_name),
  KEY idx_employee_manager_id (manager_id),
  KEY fk_employee_company (company_id),
  KEY idx_employee_leave_day (leave_day)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE IF NOT EXISTS employee_assignment (
  id BIGINT(19) NOT NULL AUTO_INCREMENT,
  employee_id BIGINT(19) NOT NULL,
  department_id BIGINT(19) NOT NULL,
  percent INT(10) NOT NULL DEFAULT 100,
  start_date DATE NULL,
  end_date DATE NULL,
  created_by BIGINT(19) NULL,
  created_at DATETIME NULL,
  updated_by BIGINT(19) NULL,
  updated_at DATETIME NULL,
  PRIMARY KEY (id),
  KEY idx_employee_assignment_percent (employee_id, percent),
  KEY idx_employee_assignment_department (department_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE IF NOT EXISTS employee_profile (
  employee_id BIGINT(19) NOT NULL,
  blood_type VARCHAR(8) NULL,
  birthday DATE NULL,
  married VARCHAR(16) NULL,
  country VARCHAR(32) NULL,
  stn_id VARCHAR(64) NULL,
  passport VARCHAR(64) NULL,
  degree VARCHAR(32) NULL,
  mobile VARCHAR(32) NULL,
  mobile_code VARCHAR(16) NULL,
  job_fax VARCHAR(32) NULL,
  postal_addr VARCHAR(255) NULL,
  postal_tel VARCHAR(32) NULL,
  postal_code VARCHAR(16) NULL,
  home_addr VARCHAR(255) NULL,
  home_tel VARCHAR(32) NULL,
  interest VARCHAR(255) NULL,
  contact_name VARCHAR(64) NULL,
  contact_relation VARCHAR(32) NULL,
  contact_tel VARCHAR(32) NULL,
  memo VARCHAR(500) NULL,
  created_by BIGINT(19) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_by BIGINT(19) NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (employee_id),
  KEY idx_employee_profile_birthday (birthday),
  KEY idx_employee_profile_degree (degree)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE IF NOT EXISTS employee_delegate (
  id BIGINT(19) NOT NULL AUTO_INCREMENT,
  employee_id BIGINT(19) NOT NULL,
  delegate_employee_id BIGINT(19) NOT NULL,
  source_form_type VARCHAR(64) NOT NULL,
  source_form_id BIGINT(19) NOT NULL,
  start_time DATETIME(3) NOT NULL,
  end_time DATETIME(3) NOT NULL,
  delegate_all_forms TINYINT(1) NOT NULL DEFAULT 1,
  status VARCHAR(32) NOT NULL,
  paused TINYINT(1) NOT NULL DEFAULT 0,
  note VARCHAR(1024) NULL,
  created_by BIGINT(19) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_by BIGINT(19) NULL,
  updated_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_employee_delegate_source (source_form_type, source_form_id),
  KEY idx_employee_delegate_employee_time (employee_id, start_time, end_time),
  KEY idx_employee_delegate_delegate_time (delegate_employee_id, start_time, end_time),
  KEY idx_employee_delegate_status (status),
  KEY idx_employee_delegate_source_type (source_form_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;
