set -eu
umask 077

openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 7 \
  -subj /CN=GIS-Gateway-Root -keyout gateway-root-key.pem -out gateway-root.pem \
  -addext basicConstraints=critical,CA:TRUE,pathlen:1 -addext keyUsage=critical,keyCertSign,cRLSign
openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
  -subj /CN=GIS-Gateway-Issuer -keyout gateway-issuer-key.pem -out gateway-issuer.csr
cat > gateway-certificate.cnf <<'EOF'
[issuer]
basicConstraints = critical,CA:TRUE,pathlen:0
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid,issuer

[ca]
default_ca = test
[test]
database = gateway-certificate-index.txt
serial = gateway-certificate-serial.txt
new_certs_dir = .
default_md = sha256
default_days = 2
policy = names

[names]
commonName = supplied

[cn_only]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = serverAuth

[server]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = serverAuth
subjectAltName = DNS:localhost
EOF
openssl x509 -req -days 5 -in gateway-issuer.csr -CA gateway-root.pem -CAkey gateway-root-key.pem \
  -CAcreateserial -extfile gateway-certificate.cnf -extensions issuer -out gateway-issuer.pem
touch gateway-certificate-index.txt
printf '1000\n' > gateway-certificate-serial.txt
issue() {
  name=$1
  shift
  common_name=$name
  extensions=server
  if [ "$name" = https-cn-only ]; then
    common_name=localhost
    extensions=cn_only
  fi
  openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
    -subj "/CN=$common_name" -keyout "$name-key.pem" -out "$name.csr"
  openssl ca -batch -notext -config gateway-certificate.cnf -cert gateway-issuer.pem -keyfile gateway-issuer-key.pem \
    -extensions "$extensions" -in "$name.csr" -out "$name-leaf.pem" "$@"
  cat "$name-leaf.pem" gateway-issuer.pem > "$name-cert.pem"
}
issue https -days 2
issue https-next -days 3
issue https-cn-only
issue https-expired -startdate 20000101000000Z -enddate 20000102000000Z
issue https-future -startdate 20900101000000Z -enddate 20900102000000Z
