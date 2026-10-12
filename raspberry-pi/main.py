from flask import Flask, flash, request, redirect, url_for, render_template, Response, send_from_directory, session, jsonify
import RPi.GPIO as GPIO
import subprocess
from subprocess import Popen, PIPE, check_output
import html
import os, time, sys
import threading
from werkzeug.utils import secure_filename
from camera import VideoCamera
from MCP23008 import MCP23008
from MCP4725 import MCP4725
import serial
import requests
import jwt
import json
from jwt.algorithms import RSAAlgorithm
from urllib.parse import quote
from pi_config import UTILIZADORES_ACESSO_DIRETO

pi_camera = VideoCamera(flip=False) # inverter camera 180º

UPLOAD_FOLDER = '/home/admin/project/uploaded_files'
AVRDUDE_CONF_FILE = '/home/admin/project/avrdude_gpio.conf'
ATMEGA_CHIP = 'atmega128'
AVR_LFUSE = '0xFF'
AVR_HFUSE = '0x9F'
AVR_EFUSE = '0xFF'
#ATMEGA_CHIP = 'atmega328p'
MCP23008_adress = 0x20
MCP4725_address = 0x62
#SERIAL_PORT = '/dev/ttyUSB0'
#SERIAL_PORT = '/dev/ttyAMA0'
SERIAL_PORT = '/dev/serial0'

# Segredo partilhado com o Node — só as rotas de controlo do admin (switch/DAC/
# série) o exigem, para confirmar que o pedido veio mesmo do Node e não de
# alguém a bater diretamente no IP do Pi. Tem de ser exatamente igual ao
# PI_ADMIN_SECRET do backend/.env.
PI_ADMIN_SECRET = os.environ["PI_ADMIN_SECRET"]

# Segredo usado para validar o token de sessão emitido pelo backend no
# momento da entrada (substitui o utilizador_id em bruto). Tem de ser
# exatamente igual ao PI_SESSION_SECRET do backend/.env.
PI_SESSION_SECRET = os.environ["PI_SESSION_SECRET"]

# Base do backend, para o canal de eventos de revogação de sessão.
NODE_BASE_URL = "https://www.ave.dee.isep.ipp.pt/DEE/micmic-lab"

# Reservas cuja sessão foi revogada (botão de pânico / cancelamento pelo
# admin) antes do prazo natural do token — populado pela thread de escuta.
SESSOES_REVOGADAS = set()
# Evita arrancar mais do que uma thread de escuta pela mesma reserva.
_threads_escuta_iniciadas = set()


# Criar dictionary chamada SW para guardar o pino, nome, estado e porta do MCP:
SW_list = {
   1 : {'name' : 'SW1', 'state' : False , 'pin' : 0 },
   2 : {'name' : 'SW2', 'state' : True ,  'pin' : 1 },
   3 : {'name' : 'SW3', 'state' : False , 'pin' : 2 },
   4 : {'name' : 'SW4', 'state' : False , 'pin' : 3 },
   5 : {'name' : 'SW5', 'state' : True ,  'pin' : 4 },
   6 : {'name' : 'SW6', 'state' : True ,  'pin' : 5 }
   }
#print(SW_list)

BaudRateList = {
    1 : 1200,
    2 : 2400,
    3 : 4800,
    4 : 9600,
    5 : 19200,
    6 : 38400,
    7 : 57600,
    8 : 115200
   }

flash_status = -1
flash_txt    = ""
last_page    = ""
serial_log    = ""
SerialBaudRate = 9600
DAC1_value = 0


# set up GPIO settings
GPIO.setwarnings(False)
GPIO.setmode(GPIO.BCM)
    
MCP = MCP23008(MCP23008_adress)
MCP_DAC = MCP4725(MCP4725_address)

ser = serial.Serial (port=SERIAL_PORT, baudrate = 9600, bytesize=8, timeout=1, parity=serial.PARITY_NONE, stopbits=serial.STOPBITS_ONE)

#definir pinos do MCP como saída para os botões configurados
for SW in SW_list:
    #print(SW_list[SW]['pin'])
    MCP.set_mode(SW_list[SW]['pin'], 'output')
    MCP.output(SW_list[SW]['pin'], 0)    


##### CONFIG FLASK #####
app = Flask(__name__)
def validar_no_agendamento(utilizador_id=None):
    url_do_teu_node = "https://www.ave.dee.isep.ipp.pt/DEE/micmic-lab/api/verificar-acesso"
    if not utilizador_id:
        return False
    try:
        resposta = requests.post(url_do_teu_node, json={"utilizador_id": utilizador_id}, timeout=5)
        # ADICIONA ESTAS DUAS LINHAS PARA DEBUGAR:
        print(f"Status do Node: {resposta.status_code}")
        print(f"Resposta do Node: {resposta.text}")
        
        if resposta.status_code == 200:
            return resposta.json().get("valido", False)
    except Exception as e:
        print("Erro ao ligar ao agendamento:", e)
        return False
    return False

def escutar_revogacao(token, reserva_id):
    """Corre numa thread de fundo: mantém uma ligação SSE aberta ao backend
    para esta sessão, e marca a reserva como revogada assim que recebe o
    evento 'revoke'. Volta a ligar-se automaticamente se a ligação cair por
    qualquer razão (ex: o proxy a fechar ligações paradas), até o token
    expirar ou a sessão ser mesmo revogada."""
    url = f"{NODE_BASE_URL}/api/pi/sessao-eventos"

    while reserva_id not in SESSOES_REVOGADAS:
        payload = validar_token_sessao(token)
        if not payload:
            break  # token expirou entretanto — nada mais a escutar

        try:
            with requests.get(url, params={"token": token}, stream=True, timeout=30) as resposta:
                for linha in resposta.iter_lines(decode_unicode=True):
                    if linha and linha.startswith("data:") and "revoke" in linha:
                        print(f"[SESSAO] Revogação recebida para a reserva {reserva_id}")
                        SESSOES_REVOGADAS.add(reserva_id)
                        break
        except Exception as e:
            print(f"[SESSAO] Ligação de revogação caiu para a reserva {reserva_id}, a tentar de novo: {e}")
            time.sleep(2)

    _threads_escuta_iniciadas.discard(reserva_id)



def validar_token_sessao(token):
    """Decifra o token de sessão emitido pelo backend no momento da entrada
    (/api/confirmar-entrada). Devolve o payload (utilizador_id, reserva_id)
    se for válido e ainda não tiver sido revogado, ou None caso contrário."""
    if not token:
        return None
    try:
        payload = jwt.decode(token, PI_SESSION_SECRET, algorithms=["HS256"])
    except Exception as e:
        print("Token de sessão inválido:", e)
        return None

    if payload.get('reserva_id') in SESSOES_REVOGADAS:
        return None

    return payload


JWKS_URL = 'https://www.ave.dee.isep.ipp.pt/DEE/auth/.well-known/jwks.json'
DEE_LOGIN_URL = 'https://www.ave.dee.isep.ipp.pt/DEE/auth/login.php'


def _obter_chave_publica_dee():
    """Vai buscar a JWKS do DEE e devolve a chave pública para verificar assinaturas.
    O token do DEE não inclui 'kid' no cabeçalho, por isso não dá para usar o
    PyJWKClient normal (que escolhe a chave pelo 'kid') — vamos buscar
    diretamente a (única) chave disponível."""
    resposta = requests.get(JWKS_URL, timeout=5)
    jwk = resposta.json()['keys'][0]
    return RSAAlgorithm.from_jwk(json.dumps(jwk))


def validar_jwt_dee(token):
    """Verifica a assinatura do JWT emitido pelo DEE e devolve o payload,
    ou None se for inválido/expirado."""
    try:
        chave_publica = _obter_chave_publica_dee()
        return jwt.decode(token, chave_publica, algorithms=["RS512"])
    except Exception as e:
        print("Erro ao validar JWT do DEE:", e)
        return None


def tem_acesso_direto():
    """True se a sessão atual pertence a um utilizador autorizado a login direto."""
    return session.get('utilizador_direto') in UTILIZADORES_ACESSO_DIRETO


def pedido_e_do_admin():
    """True se o pedido trouxer o segredo partilhado certo (só o Node o conhece)."""
    return request.headers.get('X-Admin-Secret') == PI_ADMIN_SECRET

app.config['UPLOAD_FOLDER'] = UPLOAD_FOLDER
app.secret_key = 'super secret key'
app.config['SESSION_TYPE'] = 'filesystem'

#criar routes

@app.route("/")
def index():
    token = request.args.get('token')
    if token:
        return redirect(f'/main?page=terminal&token={token}')

    # Está a voltar do DEE com um token para validar
    auth_jwt = request.args.get('auth_jwt') or request.args.get('jwt')
    if auth_jwt:
        payload = validar_jwt_dee(auth_jwt)
        if not payload:
            return "Acesso negado: token DEE inválido ou expirado.", 403

        username = (payload.get('data') or {}).get('username')
        if username not in UTILIZADORES_ACESSO_DIRETO:
            return "Acesso negado: este utilizador não está autorizado para login direto no laboratório.", 403

        session['utilizador_direto'] = username
        return redirect('/main?page=terminal')

    # Sem token e sem acesso direto: manda sempre autenticar no DEE outra vez
    # (não confiamos numa sessão antiga guardada no browser para dar acesso direto)
    callback_url = request.url_root
    login_url = f"{DEE_LOGIN_URL}?requester={quote(callback_url, safe='')}"
    return redirect(login_url)


########### Main Page #######################    
@app.route('/main', methods = ['GET', 'POST'])
def main():
    global flash_status
    global flash_txt
    global last_page
    global SerialBaudRate
    global serial_log
    global DAC1_value

    # Tenta apanhar o token do URL ou da memória (session)
    token = request.args.get('token') or session.get('token_sessao')
    payload = validar_token_sessao(token)

    if payload:
        session['token_sessao'] = token
        session['utilizador_id'] = payload.get('utilizador_id')

        reserva_id = payload.get('reserva_id')
        if reserva_id is not None and reserva_id not in _threads_escuta_iniciadas:
            _threads_escuta_iniciadas.add(reserva_id)
            threading.Thread(target=escutar_revogacao, args=(token, reserva_id), daemon=True).start()
    elif tem_acesso_direto():
        session.pop('token_sessao', None)
        session.pop('utilizador_id', None)
        token = None
    else:
        session.pop('token_sessao', None)
        session.pop('utilizador_id', None)
        return "<h1>Acesso Negado ou Expirado</h1><p>O teu tempo terminou, não tens nenhuma reserva ativa, ou não tens autorização de acesso direto.</p>", 403

    page_request = request.args.get('page', 'terminal')

    data = {'page': page_request,
        'SW_list' : SW_list,
        'FlashStatus' : flash_status,
        'FlashTxt': flash_txt,
        'BaudRateList' : BaudRateList,
        'SerialBaudRate': SerialBaudRate,
        'SerialLog' : serial_log,
        'DAC1Value' : DAC1_value,
        'UploadFolder': UPLOAD_FOLDER,
        'AVRDUDE_conf': AVRDUDE_CONF_FILE,
        'ATMEGAchip' : ATMEGA_CHIP,
        'MCP23008_adress' : hex(MCP23008_adress),
        'MCP4725_address' : hex(MCP4725_address),
        'SerialPort' : SERIAL_PORT,
        'LFuse' : AVR_LFUSE,
        'HFuse' : AVR_HFUSE,
        'EFuse' : AVR_EFUSE,
        'Token' : token,
        # Para o IOinterface.html poder chamar /api/estado-live sem precisar
        # de repetir a lógica de sessão — usa o mesmo utilizador_id que já
        # validámos acima a partir do token.
        'UtilizadorId': payload.get('utilizador_id') if payload else None
        }

    
    if page_request != last_page:
        flash_status = -1
        flash_txt = ""
        last_page = request.args['page']

        if last_page == "upload":
            run_command("sudo python3 project/neopixel_setRGB.py 255 255 0")
        elif last_page == "terminal":
            run_command("sudo python3 project/neopixel_setRGB.py 0 255 0")
        elif last_page == "IOinterface":
            run_command("sudo python3 project/neopixel_setRGB.py 255 0 0")
        else: #"settings":
            run_command("sudo python3 project/neopixel_setRGB.py 0 128 255")
        
    
    # verifica se o post request contem um ficheiro-> direciona para o upload
    if request.method == 'POST' and 'file' in request.files:  
        file = request.files['file']
        # Verifica se existe se o nome existe 
        if file.filename == '':
            flash('No selected file')
            return redirect(request.url)
        #Confirmar se a extensão é hex
        if file.filename.rsplit('.', 1)[1].lower() =='hex':
            filename = secure_filename(file.filename)
            file.save(os.path.join(app.config['UPLOAD_FOLDER'], filename))
            #return redirect(url_for('flashATmega', file_name=filename))
            #return 'file uploaded successfully'
            flash_status, flash_txt = flashATmega(filename)
            print(flash_txt)
            return redirect(request.url)
            
        else:
            flash('Extensão de ficheiro não válida. Apenas são aceites ficheiros *.hex')
            return redirect(request.url)
    # verifica se o post request contem o form SW_click
    elif request.method == 'POST' and request.form.get('SW_click'):
        #atualizar dictionary
        for SW in SW_list:
            if SW_list[SW]['name'] == request.form.get('SW_click'):
                if SW_list[SW]['state'] == True:
                    SW_list[SW]['state'] = False
                else:
                    SW_list[SW]['state'] = True
            
        
        #atualizar saídas do MCP
        for SW in SW_list:
            MCP.output(SW_list[SW]['pin'], SW_list[SW]['state'])
        return redirect(request.url)

    # verifica se o post request contem o form BaudRate change
    elif request.method == 'POST' and request.form.get('BaudRateChange'):
        
        SerialBaudRate = request.form.get('BaudRateChange')
        ser.baudrate = SerialBaudRate
        #print("New BaudRate="+request.form.get('BaudRateChange'))
        return redirect(request.url)
 
     # verifica se o post request contem o form Clear Console
    elif request.method == 'POST' and request.form.get('CLRconsole'):
        serial_log = "" #Apagar variavél com o log TX-RX
        #print("Clear Console")
        return redirect(request.url)

     # verifica se o post request contem o form Enviar por Serie
    elif request.method == 'POST' and request.form.get('TXsend'):
        #ser.isOpen()
        ser.flush()
        #ser.write(("Script Started").encode())
        ser.write(request.form.get('TXsend').encode())
        ser.write(("\r\n").encode())
        serial_log = "TX>> " + request.form.get('TXsend') + "\r\n" + serial_log    
        #print("Serial TX:" + request.form.get('TXsend'))
        return redirect(request.url)
         # verifica se o post request contem o form DAC1
    elif request.method == 'POST' and request.form.get('DAC1'):
        print("DAC - new value: " + request.form.get('DAC1'))
        DAC1_value = int(request.form.get('DAC1'))
        MCP_DAC.set_voltage(DAC1_value)
        #print("Clear Console")
        return redirect(request.url)
    
    
    else:
        return render_template('main.html', **data)

######################### IO INTERFACE PAGE #############################
@app.route('/IOinterface')
def IOinterface():

    return render_template('IOinterface.html')

######################### ESTADO EM DIRETO (para o Painel Admin) #############################
@app.route('/api/estado-live')
def estado_live():
    utilizador_id = request.args.get('utilizador_id')

    if not utilizador_id or not validar_no_agendamento(utilizador_id):
        return jsonify({"erro": "Acesso negado ou sessão inválida/expirada."}), 403

    # Devolve o log série só com as últimas ~2000 chars para não ficar pesado
    log_reduzido = serial_log[:2000] if serial_log else ""

    return jsonify({
        "switches": SW_list,
        "dac_value": DAC1_value,
        "baud_rate": SerialBaudRate,
        "serial_log_tail": log_reduzido
    })

##########################################################
def gen(camera):
    camera.add_viewer()
    try:
        while True:
            frame = camera.get_shared_frame()
            if frame is None:
                continue
            yield (b'--frame\r\n'
                   b'Content-Type: image/jpeg\r\n\r\n' + frame + b'\r\n')
    finally:
        camera.remove_viewer()
##########################################################
# ======================================================
# DESLIGAR TUDO — chamado pelo servidor Node quando uma
# reserva termina. Põe os 6 interruptores a OFF e o DAC a 0.
# Protegido pela mesma validação de sessão ativa.
# ======================================================
@app.route('/api/desligar-tudo')
def desligar_tudo():
    global DAC1_value

    utilizador_id = request.args.get('utilizador_id')
    if not utilizador_id or not validar_no_agendamento(utilizador_id):
        return jsonify({"erro": "Acesso negado ou sessão inválida/expirada."}), 403

    # Desligar todos os interruptores
    for SW in SW_list:
        SW_list[SW]['state'] = False
        MCP.output(SW_list[SW]['pin'], False)

    # Cortar o DAC
    DAC1_value = 0
    try:
        MCP_DAC.set_voltage(0)
    except Exception as e:
        print("Erro ao cortar DAC:", e)

    print("[DESLIGAR-TUDO] Todos os interruptores e DAC foram desligados.")
    return jsonify({"sucesso": True, "mensagem": "Laboratório desligado com sucesso."})

# ======================================================
# CONTROLO DO HARDWARE PELO ADMIN (switch, DAC, porta série)
# Chamado pelo Node (nunca diretamente pelo browser) — protegido pelo
# segredo partilhado, não por uma reserva de aluno.
# ======================================================
@app.route('/api/admin/switch', methods=['POST'])
def admin_switch():
    if not pedido_e_do_admin():
        return jsonify({"erro": "Acesso negado."}), 403

    dados = request.get_json(silent=True) or {}
    nome = dados.get('nome')
    if not nome:
        return jsonify({"erro": "Nome do switch em falta."}), 400

    encontrado = False
    for SW in SW_list:
        if SW_list[SW]['name'] == nome:
            SW_list[SW]['state'] = not SW_list[SW]['state']
            MCP.output(SW_list[SW]['pin'], SW_list[SW]['state'])
            encontrado = True

    if not encontrado:
        return jsonify({"erro": "Switch não encontrado."}), 404

    return jsonify({"sucesso": True, "switches": SW_list})


@app.route('/api/admin/dac', methods=['POST'])
def admin_dac():
    global DAC1_value

    if not pedido_e_do_admin():
        return jsonify({"erro": "Acesso negado."}), 403

    dados = request.get_json(silent=True) or {}
    valor = dados.get('valor')
    if valor is None:
        return jsonify({"erro": "Valor do DAC em falta."}), 400

    try:
        valor = int(valor)
    except (TypeError, ValueError):
        return jsonify({"erro": "Valor do DAC inválido."}), 400

    if valor < 0 or valor > 4095:
        return jsonify({"erro": "Valor do DAC fora do intervalo (0-4095)."}), 400

    DAC1_value = valor
    MCP_DAC.set_voltage(DAC1_value)
    return jsonify({"sucesso": True, "dac_value": DAC1_value})


@app.route('/api/admin/serial', methods=['POST'])
def admin_serial():
    global serial_log

    if not pedido_e_do_admin():
        return jsonify({"erro": "Acesso negado."}), 403

    dados = request.get_json(silent=True) or {}
    texto = dados.get('texto')
    if not texto:
        return jsonify({"erro": "Texto em falta."}), 400

    ser.flush()
    ser.write(texto.encode())
    ser.write(("\r\n").encode())
    serial_log = "TX>> " + texto + "\r\n" + serial_log

    return jsonify({"sucesso": True})

##########################################################
# Protegido: token de sessão válido (aluno) OU acesso direto (utilizador especial).
@app.route('/video_feed')
def video_feed():
    token = request.args.get('token')
    autorizado = bool(validar_token_sessao(token)) or tem_acesso_direto()
    if not autorizado:
        return jsonify({"erro": "Acesso negado ou sessão inválida/expirada."}), 403

    return Response(gen(pi_camera),
                    mimetype='multipart/x-mixed-replace; boundary=frame')

##########################################################
def log():
    global serial_log
    while True:
        if ser.in_waiting:
            data_received = str(ser.readline(),encoding='utf-8')
            serial_log = "RX<< " + data_received + " \n" + serial_log
            #print("RX<< " + data_received
        yield (serial_log)
##########################################################
# Protegido: mesma regra do vídeo (token de sessão válido OU acesso direto).
@app.route('/serial_feed')
def serial_feed():
    global serial_log

    token = request.args.get('token')
    autorizado = bool(validar_token_sessao(token)) or tem_acesso_direto()
    if not autorizado:
        return jsonify({"erro": "Acesso negado ou sessão inválida/expirada."}), 403

    if ser.in_waiting:
        data_received = str(ser.readline(),encoding='utf-8')
        serial_log = "RX<< " + data_received + serial_log
        #print("RX<< " + str(ser.readline()))
    return Response(serial_log, mimetype='text/xml')

 

#Flashar ATMEGA
#@app.route("/flashATmega/<file_name>")
def flashATmega(file_name):
    #definir TXD pin como input. Se estiver a high o ATMEGA não flasha
    #TXD por defeito está a high
    GPIO.setup(14, GPIO.IN)

    #Send AVR Fuses
    result_fuses = run_command("sudo avrdude -p " + ATMEGA_CHIP + " -C " + AVRDUDE_CONF_FILE + " -c pi -q -U lfuse:w:" + AVR_LFUSE +":m -U hfuse:w:" + AVR_HFUSE +":m -U efuse:w:" + AVR_EFUSE +":m")
    result_flash = run_command("sudo avrdude -p " + ATMEGA_CHIP + " -C " + AVRDUDE_CONF_FILE + " -c pi -v -U flash:w:" + os.path.join(app.config['UPLOAD_FOLDER'], file_name) + ":i")
    #sudo avrdude -p atmega328p -C ~/project/avrdude_gpio.conf -c pi -v -U flash:w:/home/admin/Desktop/sistema_minimo.hex:i

    #definit pino TXD (GPIO14) novamente para porta serie
    run_command("sudo gpio -g mode 14 alt5")
    ser = serial.Serial (port=SERIAL_PORT, baudrate = SerialBaudRate, bytesize=8, timeout=1, parity=serial.PARITY_NONE, stopbits=serial.STOPBITS_ONE)
    
    ### CONVERTER "ENTER" PARA HTML ###
    txt = "############## FUSES #################\n"
    txt = txt + str(result_fuses[2]).replace("\\n", " \n")
    
    txt = txt + "\n############## FLASH #################\n"
    txt = txt + str(result_flash[2]).replace("\\n", " \n") 
    if result_fuses[0]==0 and result_flash[0]==0:
        return 1, txt
    else:
        return 0, txt

   

#--------------------------------------------------------------
#Executar comando na shell
#--------------------------------------------------------------
def run_command(command):
    process = subprocess.Popen(command, shell=True,
                           stdout=subprocess.PIPE, 
                           stderr=subprocess.PIPE)
    # wait for the process to terminate
    out, err = process.communicate()
    #returncode 0-> OK ; 1=erro
    return(process.returncode,out,err) 
#--------------------------------------------------------------

#Colocar WebServer em Run
app.run(host="0.0.0.0", port=5000)
