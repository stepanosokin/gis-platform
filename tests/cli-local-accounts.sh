set -eu

chmod 700 /root
for account in operator agent; do
    useradd -m -N -g users "$account"
    install -o "$account" -m 600 "/root/input/$account.pem" "/home/$account/client.pem"
    install -o "$account" -m 600 "/root/input/$account-key.pem" "/home/$account/key.pem"
done
install -m 644 /root/input/ca.pem /tmp/ca.pem

cli() {
    account=$1
    key=$2
    shift 2
    runuser -u "$account" -- env GIS_ADMIN_PORT=3001 GIS_ADMIN_CA_FILE=/tmp/ca.pem \
        GIS_ADMIN_CERT_FILE="/home/$account/client.pem" GIS_ADMIN_KEY_FILE="$key" \
        node dist/cli.js "$@" --json
}

cli operator /home/operator/key.pem users list
cli agent /home/agent/key.pem status
status=0
cli agent /home/agent/key.pem users list || status=$?
test "$status" -eq 4
status=0
cli agent /home/operator/key.pem users list || status=$?
test "$status" -eq 4
