package record

import (
	"errors"
	"fmt"
)

// ValidateDeviceCert checks the device-cert-specific fields on top of the
// common shape: both device keys present and 32-byte b64url. It does not
// verify the signature.
func ValidateDeviceCert(cert *Record) error {
	if cert.Type() != "device-cert" {
		return errors.New("not a device-cert")
	}
	if _, err := DecodeKey(cert.str("device_sign_pub")); err != nil {
		return fmt.Errorf("device_sign_pub: %w", err)
	}
	if _, err := DecodeKey(cert.str("device_kex_pub")); err != nil {
		return fmt.Errorf("device_kex_pub: %w", err)
	}
	return nil
}

// ValidateDeviceRevoke checks the device-revoke-specific fields. It does
// not verify the signature.
func ValidateDeviceRevoke(rev *Record) error {
	if rev.Type() != "device-revoke" {
		return errors.New("not a device-revoke")
	}
	if _, err := DecodeKey(rev.str("device_sign_pub")); err != nil {
		return fmt.Errorf("device_sign_pub: %w", err)
	}
	return nil
}

// VerifyDeviceBinding verifies that a device-signed record's device is
// bound to its author: a valid device-cert for record.device signed by
// record.author exists in certs, and no revocation of that device predates
// the record (revocation.created_at <= record.created_at). Fixed-precision
// RFC 3339 UTC strings compare correctly as strings.
func VerifyDeviceBinding(rec *Record, certs, revocations []*Record) error {
	if rec.Device() == "" {
		return errors.New("record has no device field")
	}
	var cert *Record
	for _, c := range certs {
		if c.str("device_sign_pub") == rec.Device() && c.Author() == rec.Author() {
			cert = c
			break
		}
	}
	if cert == nil {
		return errors.New("no device-cert binds this device to the author")
	}
	if err := ValidateDeviceCert(cert); err != nil {
		return err
	}
	if err := cert.VerifySignature(); err != nil {
		return fmt.Errorf("device-cert: %w", err)
	}
	for _, rev := range revocations {
		if rev.str("device_sign_pub") != rec.Device() || rev.Author() != rec.Author() {
			continue
		}
		if err := ValidateDeviceRevoke(rev); err != nil {
			return err
		}
		if err := rev.VerifySignature(); err != nil {
			return fmt.Errorf("device-revoke: %w", err)
		}
		if rev.CreatedAt() <= rec.CreatedAt() {
			return errors.New("device was revoked before this record")
		}
	}
	return nil
}

// Verify fully verifies a device-signed record: its own signature plus the
// device-cert binding.
func Verify(rec *Record, certs, revocations []*Record) error {
	if err := rec.VerifySignature(); err != nil {
		return err
	}
	return VerifyDeviceBinding(rec, certs, revocations)
}
