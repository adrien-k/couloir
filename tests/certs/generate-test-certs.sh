# #!/bin/sh
#
# This can be used to generate a self-signed certificate for testing purposes.
#
#
openssl genrsa -des3 -out ca.key 2048
openssl req -x509 -new -nodes -key ca.key -sha256 -days 1825 -out ca.pem

openssl genrsa -out cert.key 2048
openssl req -new -key cert.key -out cert.csr

openssl x509 -req -in cert.csr -CA ca.pem -CAkey ca.key -CAcreateserial -out cert.pem -days 825 -sha256 -extfile cert.ext


mkdir -p "*.test.local"
mkdir -p "test.local"

cp cert.key "*.test.local"
cp cert.pem "*.test.local"
cp cert.key "test.local"
cp cert.pem "test.local"
rm cert.key cert.pem